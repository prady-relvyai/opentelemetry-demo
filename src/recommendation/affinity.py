"""Category affinity scoring for personalized recommendations.

Tracks which product categories a user has browsed/purchased to boost
recommendations from preferred categories. Uses exponential decay so
recent interactions weigh more heavily.
"""

import time
import math
from collections import defaultdict
from opentelemetry import trace

# Category mapping for the demo product catalog
PRODUCT_CATEGORIES = {
    "OLJCESPC7Z": "electronics",     # Vintage Typewriter
    "66VCHSJNUP": "electronics",     # Vintage Camera Lens
    "1YMWWN1N4O": "home",            # Vintage Record Player
    "L9ECAV7KIM": "clothing",        # Vintage Denim Jacket
    "2ZYFJ3GM2N": "home",            # Film Projector
    "0PUK6V6EV0": "home",            # Vintage Alarm Clock
    "LS4PSXUNUM": "electronics",     # Roof Binoculars
    "9SIQT8TOJO": "outdoors",        # City Bike
    "6E92ZMYYFZ": "accessories",     # Air Plant
    "HQTGWGPNH4": "home",            # Terrarium
}

# Decay half-life in seconds (interactions older than this count half as much)
DECAY_HALF_LIFE = 3600  # 1 hour

# Module-level affinity store — keyed by user_id
# BUG: This is shared across all threads in the gRPC ThreadPoolExecutor.
# Since gRPC handlers can run concurrently, there's a race condition where
# one user's affinity state can leak into another user's scoring if the
# dict reference is read mid-update by another thread.
_user_affinities = defaultdict(lambda: defaultdict(list))


def record_interaction(user_id: str, product_ids: list):
    """Record that a user interacted with (viewed/purchased) these products."""
    tracer = trace.get_tracer("recommendation")
    with tracer.start_as_current_span("record_affinity") as span:
        now = time.time()
        categories_seen = set()

        for pid in product_ids:
            category = PRODUCT_CATEGORIES.get(pid, "other")
            _user_affinities[user_id][category].append(now)
            categories_seen.add(category)

        span.set_attribute("app.affinity.user_id", user_id)
        span.set_attribute("app.affinity.categories", list(categories_seen))
        span.set_attribute("app.affinity.interaction_count", len(product_ids))


def get_affinity_scores(user_id: str) -> dict:
    """Get category affinity scores for a user using exponential time-decay.

    Returns dict of {category: score} where score is a float 0-1.
    Categories with more recent and frequent interactions score higher.
    """
    tracer = trace.get_tracer("recommendation")
    with tracer.start_as_current_span("compute_affinity") as span:
        now = time.time()
        scores = {}
        user_data = _user_affinities[user_id]

        if not user_data:
            span.set_attribute("app.affinity.has_history", False)
            return {}

        span.set_attribute("app.affinity.has_history", True)

        for category, timestamps in user_data.items():
            score = 0.0
            for ts in timestamps:
                age = now - ts
                decay = math.exp(-0.693 * age / DECAY_HALF_LIFE)
                score += decay
            scores[category] = score

        # Normalize to 0-1 range
        max_score = max(scores.values()) if scores else 1.0
        if max_score > 0:
            scores = {k: v / max_score for k, v in scores.items()}

        span.set_attribute("app.affinity.scores", str(scores))
        return scores


def rank_by_affinity(user_id: str, product_ids: list, boost_factor: float = 2.0) -> list:
    """Re-rank product IDs by affinity score. Products in preferred categories
    are boosted by `boost_factor` in the scoring, making them more likely
    to appear first in the recommendation list.

    Returns a sorted list of product_ids (highest affinity first).
    """
    scores = get_affinity_scores(user_id)

    if not scores:
        return product_ids

    def product_score(pid):
        category = PRODUCT_CATEGORIES.get(pid, "other")
        affinity = scores.get(category, 0.0)
        return affinity * boost_factor

    ranked = sorted(product_ids, key=product_score, reverse=True)
    return ranked
