-- Found by the regression suite (2026-09-12): DECIMAL with no precision/scale defaults to (65,30), so
-- cost.toString() returned e.g. "9000.000000000000000000000000" - stripping non-digits for comparison in
-- guardAgainstShippingCostHallucination then concatenated the 30 fractional zeros onto the integer part,
-- making every real, correctly-quoted shipping cost look like a mismatch. Match Product.price's precision.
ALTER TABLE "ShippingRate" ALTER COLUMN "cost" TYPE DECIMAL(12,2);
