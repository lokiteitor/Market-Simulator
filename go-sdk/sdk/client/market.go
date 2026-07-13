package client

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

// GetTopOfBook retrieves the best bid and ask (level 1 book) for a product.
func (c *Client) GetTopOfBook(ctx context.Context, productID string) (*models.TopOfBook, error) {
	var resp models.TopOfBook
	err := c.do(ctx, http.MethodGet, fmt.Sprintf("/market/%s/top", productID), nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// MarketTradesFilter se mantiene como alias del tipo compartido en models
// (lo usa también strategy.MarketData sin depender del paquete client).
type MarketTradesFilter = models.TradesQuery

// GetRecentTrades retrieves the recent trades for a product.
func (c *Client) GetRecentTrades(ctx context.Context, productID string, filter MarketTradesFilter) ([]models.Trade, error) {
	u, err := url.Parse(fmt.Sprintf("/market/%s/trades", productID))
	if err != nil {
		return nil, err
	}
	q := u.Query()
	if filter.Since != "" {
		q.Set("since", filter.Since)
	}
	if filter.Until != "" {
		q.Set("until", filter.Until)
	}
	if filter.Before != "" {
		q.Set("before", filter.Before)
	}
	if filter.Limit > 0 {
		q.Set("limit", strconv.Itoa(filter.Limit))
	}
	u.RawQuery = q.Encode()

	var resp []models.Trade
	err = c.do(ctx, http.MethodGet, u.String(), nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return resp, nil
}
