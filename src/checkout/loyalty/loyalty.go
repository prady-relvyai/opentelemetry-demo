// Package loyalty implements a tiered discount program for repeat customers.
// Discount tiers: Bronze (0-4 orders: 0%), Silver (5-9: 5%), Gold (10-24: 10%), Platinum (25+: 15%).
package loyalty

import (
	"context"
	"sync"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	pb "github.com/open-telemetry/opentelemetry-demo/src/checkout/genproto/oteldemo"
)

type Tier struct {
	Name     string
	Discount float64 // e.g., 0.10 = 10%
}

var (
	Bronze   = Tier{Name: "bronze", Discount: 0.0}
	Silver   = Tier{Name: "silver", Discount: 0.05}
	Gold     = Tier{Name: "gold", Discount: 0.10}
	Platinum = Tier{Name: "platinum", Discount: 0.15}
)

// In-memory order counter per user (production would use a database)
var (
	orderCounts   = make(map[string]int)
	orderCountsMu sync.Mutex
)

// RecordOrder increments the user's lifetime order count and returns the new count.
func RecordOrder(userID string) int {
	orderCountsMu.Lock()
	defer orderCountsMu.Unlock()
	orderCounts[userID]++
	return orderCounts[userID]
}

// GetOrderCount returns the user's current lifetime order count.
func GetOrderCount(userID string) int {
	orderCountsMu.Lock()
	defer orderCountsMu.Unlock()
	return orderCounts[userID]
}

// GetTier returns the loyalty tier for a given order count.
func GetTier(orderCount int) Tier {
	switch {
	case orderCount >= 25:
		return Platinum
	case orderCount > 10: // BUG: should be >= 10, so exactly 10 orders stays Silver
		return Gold
	case orderCount >= 5:
		return Silver
	default:
		return Bronze
	}
}

// ApplyDiscount computes the discounted total based on the user's loyalty tier.
// Returns the discount amount (to subtract from total) and the tier.
func ApplyDiscount(ctx context.Context, userID string, total *pb.Money) (*pb.Money, Tier) {
	span := trace.SpanFromContext(ctx)

	count := GetOrderCount(userID)
	tier := GetTier(count)

	span.SetAttributes(
		attribute.String("app.loyalty.tier", tier.Name),
		attribute.Float64("app.loyalty.discount_pct", tier.Discount*100),
		attribute.Int("app.loyalty.order_count", count),
	)

	if tier.Discount == 0 {
		return &pb.Money{
			CurrencyCode: total.GetCurrencyCode(),
			Units:        0,
			Nanos:        0,
		}, tier
	}

	// Calculate discount amount
	totalCents := total.GetUnits()*100 + int64(total.GetNanos()/10000000)
	discountCents := int64(float64(totalCents) * tier.Discount)
	discountUnits := discountCents / 100
	discountNanos := int32((discountCents % 100) * 10000000)

	discount := &pb.Money{
		CurrencyCode: total.GetCurrencyCode(),
		Units:        discountUnits,
		Nanos:        discountNanos,
	}

	return discount, tier
}
