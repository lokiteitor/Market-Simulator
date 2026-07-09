package client

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

// GetAgentSnapshot retrieves the full snapshot of the authenticated agent.
func (c *Client) GetAgentSnapshot(ctx context.Context, eventsLimit int) (*models.AgentSnapshot, error) {
	u, err := url.Parse("/agents/me")
	if err != nil {
		return nil, err
	}
	if eventsLimit > 0 {
		q := u.Query()
		q.Set("events_limit", strconv.Itoa(eventsLimit))
		u.RawQuery = q.Encode()
	}

	var resp models.AgentSnapshot
	err = c.do(ctx, http.MethodGet, u.String(), nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// GetCapacities retrieves the productive capacities of the authenticated agent.
func (c *Client) GetCapacities(ctx context.Context) ([]models.CapacityStatus, error) {
	var resp []models.CapacityStatus
	err := c.do(ctx, http.MethodGet, "/agents/me/capacities", nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// GetInventory retrieves the aggregated inventory positions of the authenticated agent.
func (c *Client) GetInventory(ctx context.Context, productID string) ([]models.InventoryPosition, error) {
	u, err := url.Parse("/agents/me/inventory")
	if err != nil {
		return nil, err
	}
	if productID != "" {
		q := u.Query()
		q.Set("product_id", productID)
		u.RawQuery = q.Encode()
	}

	var resp []models.InventoryPosition
	err = c.do(ctx, http.MethodGet, u.String(), nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// GetInventoryLots retrieves the detailed FIFO lot inventory of the authenticated agent.
func (c *Client) GetInventoryLots(ctx context.Context, productID string, onlyWithStock bool) ([]models.InventoryLot, error) {
	u, err := url.Parse("/agents/me/inventory/lots")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	if productID != "" {
		q.Set("product_id", productID)
	}
	q.Set("only_with_stock", strconv.FormatBool(onlyWithStock))
	u.RawQuery = q.Encode()

	var resp []models.InventoryLot
	err = c.do(ctx, http.MethodGet, u.String(), nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// GetAgentPublic retrieves public information of any agent.
func (c *Client) GetAgentPublic(ctx context.Context, agentID string) (*models.AgentPublic, error) {
	var resp models.AgentPublic
	err := c.do(ctx, http.MethodGet, fmt.Sprintf("/agents/%s", agentID), nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}
