package client

import (
	"context"
	"net/http"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

// Register registers a new agent in the simulation.
func (c *Client) Register(ctx context.Context, req models.RegisterAgentRequest) (*models.RegisterAgentResponse, error) {
	var resp models.RegisterAgentResponse
	err := c.do(ctx, http.MethodPost, "/auth/register", req, &resp, false)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// Login authenticates an existing agent.
func (c *Client) Login(ctx context.Context, req models.LoginRequest) (*models.TokenPair, error) {
	var resp models.TokenPair
	err := c.do(ctx, http.MethodPost, "/auth/login", req, &resp, false)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// Refresh exchanges a refresh token for a new token pair.
func (c *Client) Refresh(ctx context.Context, req models.RefreshRequest) (*models.TokenPair, error) {
	var resp models.TokenPair
	err := c.do(ctx, http.MethodPost, "/auth/refresh", req, &resp, false)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// Logout revokes the provided refresh token.
func (c *Client) Logout(ctx context.Context, req models.RefreshRequest) error {
	return c.do(ctx, http.MethodPost, "/auth/logout", req, nil, true)
}
