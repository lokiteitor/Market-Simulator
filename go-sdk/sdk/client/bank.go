package client

import (
	"context"
	"net/http"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

// GetBankInfo retrieves the central bank's monetary policy and live state
// (gold-standard parity, window bid/ask, reserves, issuance capacity).
// La paridad es FIJA durante la corrida: basta con leerla una vez en
// Initialize y cachearla; las reservas/contadores sí cambian.
func (c *Client) GetBankInfo(ctx context.Context) (*models.BankInfo, error) {
	var resp models.BankInfo
	err := c.do(ctx, http.MethodGet, "/bank", nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// ConvertGold executes a conversion at the central bank window:
// sell_gold entrega oro del inventario del agente y acredita dinero recién
// acuñado a window_bid; buy_gold paga a window_ask (dinero destruido) y
// recibe oro de la reserva del banco. Sin fees.
func (c *Client) ConvertGold(ctx context.Context, req models.ConvertGoldRequest) (*models.GoldConversion, error) {
	var resp models.GoldConversion
	err := c.do(ctx, http.MethodPost, "/bank/convert", req, &resp, true)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}
