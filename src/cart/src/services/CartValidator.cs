// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Linq;
using Oteldemo;

namespace cart.services;

public class CartValidationConfig
{
    public int MaxQuantityPerItem { get; set; } = 10;
    public int MaxUniqueItems { get; set; } = 20;
    public int MaxTotalQuantity { get; set; } = 100;
}

public enum CartValidationResult
{
    Valid,
    InvalidQuantity,
    MaxUniqueItemsExceeded,
    MaxTotalQuantityExceeded,
    MaxPerItemQuantityExceeded
}

public class CartValidator
{
    private readonly CartValidationConfig _config;
    private static readonly Meter CartValidationMeter = new Meter("OpenTelemetry.Demo.Cart");
    private static readonly Counter<long> ValidationRejections = CartValidationMeter.CreateCounter<long>(
        "app.cart.validation.rejections",
        description: "Number of cart add-item requests rejected by validation");

    public CartValidator(CartValidationConfig config)
    {
        _config = config;
    }

    public CartValidationResult ValidateAddItem(Cart currentCart, string productId, int quantity)
    {
        if (quantity <= 0)
        {
            RecordRejection("invalid_quantity");
            return CartValidationResult.InvalidQuantity;
        }

        if (currentCart.Items.Count >= _config.MaxUniqueItems)
        {
            RecordRejection("max_unique_items");
            return CartValidationResult.MaxUniqueItemsExceeded;
        }

        var existingItem = currentCart.Items.FirstOrDefault(i => i.ProductId == productId);
        var newItemQuantity = (existingItem?.Quantity ?? 0) + quantity;
        if (newItemQuantity > _config.MaxQuantityPerItem)
        {
            RecordRejection("max_per_item_quantity");
            return CartValidationResult.MaxPerItemQuantityExceeded;
        }

        var totalQuantity = 0;
        foreach (var item in currentCart.Items)
        {
            totalQuantity += item.Quantity;
        }
        if (existingItem != null)
        {
            totalQuantity -= existingItem.Quantity;
        }
        totalQuantity += newItemQuantity;

        if (totalQuantity > _config.MaxTotalQuantity)
        {
            RecordRejection("max_total_quantity");
            return CartValidationResult.MaxTotalQuantityExceeded;
        }

        return CartValidationResult.Valid;
    }

    private void RecordRejection(string reason)
    {
        ValidationRejections.Add(1, new KeyValuePair<string, object?>("reason", reason));
        Activity.Current?.SetTag("app.cart.validation.rejected", true);
        Activity.Current?.SetTag("app.cart.validation.rejection_reason", reason);
    }
}
