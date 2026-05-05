// Express shipping with weight-based pricing.
//
// Provides premium shipping tiers with estimated delivery windows
// and weight-based cost calculation.

use log::info;
use opentelemetry::{trace::get_active_span, KeyValue};

/// Express shipping tiers
#[derive(Debug, Clone, Copy)]
pub enum ShippingTier {
    Standard,  // 5-7 business days
    Express,   // 2-3 business days
    Overnight, // next business day
}

impl ShippingTier {
    /// Multiplier applied to the base shipping cost for this tier
    pub fn cost_multiplier(&self) -> f64 {
        match self {
            ShippingTier::Standard => 1.0,
            ShippingTier::Express => 2.5,
            ShippingTier::Overnight => 4.0,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            ShippingTier::Standard => "standard",
            ShippingTier::Express => "express",
            ShippingTier::Overnight => "overnight",
        }
    }

    pub fn delivery_days(&self) -> (u32, u32) {
        match self {
            ShippingTier::Standard => (5, 7),
            ShippingTier::Express => (2, 3),
            ShippingTier::Overnight => (1, 1),
        }
    }
}

/// Per-kg rate tiers for weight-based pricing
const BASE_RATE_PER_KG: f64 = 1.50;
const HEAVY_THRESHOLD_KG: f64 = 10.0;
const HEAVY_SURCHARGE_PER_KG: f64 = 0.75;

/// Calculate express shipping cost based on item weights and tier.
///
/// Takes a list of (quantity, weight_kg) tuples for each item in the cart
/// and computes the total shipping cost for the given tier.
///
/// NOTE: weight_kg currently comes from item quantity field since the
/// protobuf doesn't include a weight field — treated as kg per unit.
pub fn calculate_express_cost(items: &[(u32, f64)], tier: ShippingTier) -> f64 {
    get_active_span(|span| {
        let multiplier = tier.cost_multiplier();

        let total_weight: f64 = items
            .iter()
            .map(|(quantity, weight_per_unit)| {
                // BUG: multiplier applied here (per item) instead of to the final total
                // This compounds the multiplier across items
                (*quantity as f64) * weight_per_unit * multiplier
            })
            .sum();

        let base_cost = total_weight * BASE_RATE_PER_KG;
        let surcharge = if total_weight > HEAVY_THRESHOLD_KG {
            (total_weight - HEAVY_THRESHOLD_KG) * HEAVY_SURCHARGE_PER_KG
        } else {
            0.0
        };

        let total_cost = base_cost + surcharge;

        span.set_attribute(KeyValue::new("app.shipping.tier", tier.name().to_string()));
        span.set_attribute(KeyValue::new("app.shipping.total_weight_kg", format!("{:.2}", total_weight)));
        span.set_attribute(KeyValue::new("app.shipping.base_cost", format!("{:.2}", base_cost)));
        span.set_attribute(KeyValue::new("app.shipping.surcharge", format!("{:.2}", surcharge)));
        span.set_attribute(KeyValue::new("app.shipping.express_total", format!("{:.2}", total_cost)));

        let (min_days, max_days) = tier.delivery_days();
        info!(
            "Express quote: tier={}, weight={:.2}kg, cost=${:.2}, delivery={}-{} days",
            tier.name(),
            total_weight,
            total_cost,
            min_days,
            max_days
        );

        total_cost
    })
}

/// Determine the shipping tier from a string label (from gRPC metadata or request).
pub fn parse_tier(tier_str: &str) -> ShippingTier {
    match tier_str.to_lowercase().as_str() {
        "express" => ShippingTier::Express,
        "overnight" => ShippingTier::Overnight,
        _ => ShippingTier::Standard,
    }
}
