package client

import (
	"context"
	"net/http"
	"net/url"
	"strconv"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

type HistoryTradesFilter struct {
	Side      string // buyer or seller
	ProductID string
	Since     string
	Until     string
	Limit     int
	Cursor    string
}

// GetHistoryTrades retrieves the trade history for the authenticated agent.
func (c *Client) GetHistoryTrades(ctx context.Context, filter HistoryTradesFilter) (*models.TradePage, error) {
	u, err := url.Parse("/history/trades")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	if filter.Side != "" {
		q.Set("side", filter.Side)
	}
	if filter.ProductID != "" {
		q.Set("product_id", filter.ProductID)
	}
	if filter.Since != "" {
		q.Set("since", filter.Since)
	}
	if filter.Until != "" {
		q.Set("until", filter.Until)
	}
	if filter.Limit > 0 {
		q.Set("limit", strconv.Itoa(filter.Limit))
	}
	if filter.Cursor != "" {
		q.Set("cursor", filter.Cursor)
	}
	u.RawQuery = q.Encode()

	var resp models.TradePage
	err = c.do(ctx, http.MethodGet, u.String(), nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

type HistoryEventsFilter struct {
	EventTypes []models.EventType
	Since      string
	Until      string
	Limit      int
	Cursor     string
}

// GetHistoryEvents retrieves the event history for the authenticated agent.
func (c *Client) GetHistoryEvents(ctx context.Context, filter HistoryEventsFilter) (*models.EventPage, error) {
	u, err := url.Parse("/history/events")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	for _, et := range filter.EventTypes {
		q.Add("event_type", string(et))
	}
	if filter.Since != "" {
		q.Set("since", filter.Since)
	}
	if filter.Until != "" {
		q.Set("until", filter.Until)
	}
	if filter.Limit > 0 {
		q.Set("limit", strconv.Itoa(filter.Limit))
	}
	if filter.Cursor != "" {
		q.Set("cursor", filter.Cursor)
	}
	u.RawQuery = q.Encode()

	var resp models.EventPage
	err = c.do(ctx, http.MethodGet, u.String(), nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}
