package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

type TokenProvider interface {
	GetAccessToken(ctx context.Context) (string, error)
}

// TokenInvalidator is implemented by token providers that can discard a
// cached access token the server no longer accepts (revoked session, rotated
// JWT secret, clock skew past the proactive-refresh buffer). Without it a
// locally-valid but server-rejected token would fail every request until the
// local expiry finally triggers a refresh.
type TokenInvalidator interface {
	InvalidateAccessToken()
}

type APIError struct {
	StatusCode int
	Problem    models.Problem
}

// CodeInsufficientCapital es el código de sub-error que el backend devuelve
// (422) cuando el capital disponible no alcanza para reservar una orden de
// compra o pagar el salario de una transformación.
const CodeInsufficientCapital = "insufficient_capital"

// CodeInsufficientInventory es el código de sub-error que el backend devuelve
// (422) cuando el pool disponible/reservado del agente no cubre la cantidad de
// una orden de venta o el insumo de una transformación. Señala que el
// inventario local venía adelantado respecto al servidor (drift optimista).
const CodeInsufficientInventory = "insufficient_inventory"

// HasCode indica si el Problem+JSON trae un sub-error con ese código.
func (e *APIError) HasCode(code string) bool {
	for _, err := range e.Problem.Errors {
		if err.Code == code {
			return true
		}
	}
	return false
}

func (e *APIError) Error() string {
	if len(e.Problem.Errors) > 0 {
		var subErrors []string
		for _, err := range e.Problem.Errors {
			if err.Field != nil {
				subErrors = append(subErrors, fmt.Sprintf("[%s] %s (%s)", err.Code, err.Message, *err.Field))
			} else {
				subErrors = append(subErrors, fmt.Sprintf("[%s] %s", err.Code, err.Message))
			}
		}
		return fmt.Sprintf("API error (status %d): %s: %s (details: %s)", e.StatusCode, e.Problem.Title, e.Problem.Detail, strings.Join(subErrors, "; "))
	}
	return fmt.Sprintf("API error (status %d): %s: %s", e.StatusCode, e.Problem.Title, e.Problem.Detail)
}

type Client struct {
	baseURL       string
	httpClient    *http.Client
	tokenProvider TokenProvider
}

func NewClient(baseURL string, httpClient *http.Client, tokenProvider TokenProvider) *Client {
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	// Trim trailing slash to ensure path concatenation is clean
	baseURL = strings.TrimSuffix(baseURL, "/")
	return &Client{
		baseURL:       baseURL,
		httpClient:    httpClient,
		tokenProvider: tokenProvider,
	}
}

func (c *Client) do(ctx context.Context, method, path string, body interface{}, res interface{}, authRequired bool) error {
	var bodyBytes []byte
	if body != nil {
		var err error
		bodyBytes, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("failed to marshal request body: %w", err)
		}
	}

	resp, err := c.send(ctx, method, path, bodyBytes, authRequired)
	if err != nil {
		return err
	}

	// A 401 on an authenticated call means the server rejected a token that
	// still looks valid locally. Discard it and retry once with a token
	// obtained fresh (refresh or re-login inside GetAccessToken).
	if resp.StatusCode == http.StatusUnauthorized && authRequired && c.tokenProvider != nil {
		if inv, ok := c.tokenProvider.(TokenInvalidator); ok {
			resp.Body.Close()
			inv.InvalidateAccessToken()
			resp, err = c.send(ctx, method, path, bodyBytes, authRequired)
			if err != nil {
				return err
			}
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBytes, _ := io.ReadAll(resp.Body)
		var prob models.Problem
		if err := json.Unmarshal(respBytes, &prob); err == nil && prob.Title != "" {
			return &APIError{
				StatusCode: resp.StatusCode,
				Problem:    prob,
			}
		}
		return fmt.Errorf("request failed with status %d: %s", resp.StatusCode, string(respBytes))
	}

	if res != nil && resp.StatusCode != http.StatusNoContent {
		respBytes, err := io.ReadAll(resp.Body)
		if err != nil {
			return fmt.Errorf("failed to read response body: %w", err)
		}
		if err := json.Unmarshal(respBytes, res); err != nil {
			return fmt.Errorf("failed to unmarshal response: %w (body: %s)", err, string(respBytes))
		}
	}

	return nil
}

// send builds and executes one HTTP attempt. It takes the marshalled body so
// the caller can replay the request after invalidating a rejected token.
func (c *Client) send(ctx context.Context, method, path string, bodyBytes []byte, authRequired bool) (*http.Response, error) {
	var bodyReader io.Reader
	if bodyBytes != nil {
		bodyReader = bytes.NewReader(bodyBytes)
	}

	url := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if bodyBytes != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	if authRequired && c.tokenProvider != nil {
		token, err := c.tokenProvider.GetAccessToken(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to get access token: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	return resp, nil
}

type errWrapper string

func (e errWrapper) Error() string { return string(e) }
