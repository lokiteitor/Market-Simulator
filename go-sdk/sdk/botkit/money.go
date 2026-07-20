package botkit

// El backend expresa cantidades en centi-unidades (qty_cent) y precios en
// centavos por unidad (limit_price_cents), asi que el costo de una orden es
// floor(qty_cent * limit_price_cents / 100) centavos, no qty_cent * price.
// Los helpers de este archivo mantienen esa conversion en un solo sitio.

// NotionalCents es el capital en centavos que el backend reserva por una orden
// de compra de qty_cent a limit_price_cents.
func NotionalCents(qtyCent, priceCents int64) int64 {
	return qtyCent * priceCents / 100
}

// MaxQtyForBudget es la mayor qty_cent cuyo nocional cabe en budgetCents.
func MaxQtyForBudget(budgetCents, priceCents int64) int64 {
	if priceCents <= 0 || budgetCents <= 0 {
		return 0
	}
	return budgetCents * 100 / priceCents
}

// IsReservable indica si la orden reserva al menos 1 centavo. El backend
// rechaza con 422 (insufficient_capital) las ordenes cuyo nocional redondea a
// 0, o sea qty_cent * limit_price_cents < 100.
func IsReservable(qtyCent, priceCents int64) bool {
	return qtyCent > 0 && priceCents > 0 && qtyCent*priceCents >= 100
}
