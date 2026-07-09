package client

import (
	"context"
	"fmt"
	"net/http"
	"net/url"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

// ListProducts retrieves all products in the catalog.
func (c *Client) ListProducts(ctx context.Context) ([]models.Product, error) {
	var resp []models.Product
	err := c.do(ctx, http.MethodGet, "/catalog/products", nil, &resp, false)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// GetProduct retrieves a specific product by its ID.
func (c *Client) GetProduct(ctx context.Context, productID string) (*models.Product, error) {
	var resp models.Product
	err := c.do(ctx, http.MethodGet, fmt.Sprintf("/catalog/products/%s", productID), nil, &resp, false)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// ListRecipes retrieves all recipes in the catalog, optionally filtered by the output product ID.
func (c *Client) ListRecipes(ctx context.Context, outputProductID string) ([]models.Recipe, error) {
	u, err := url.Parse("/catalog/recipes")
	if err != nil {
		return nil, err
	}
	if outputProductID != "" {
		q := u.Query()
		q.Set("output_product_id", outputProductID)
		u.RawQuery = q.Encode()
	}

	var resp []models.Recipe
	err = c.do(ctx, http.MethodGet, u.String(), nil, &resp, false)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// GetRecipe retrieves a specific recipe by its ID.
func (c *Client) GetRecipe(ctx context.Context, recipeID string) (*models.Recipe, error) {
	var resp models.Recipe
	err := c.do(ctx, http.MethodGet, fmt.Sprintf("/catalog/recipes/%s", recipeID), nil, &resp, false)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}
