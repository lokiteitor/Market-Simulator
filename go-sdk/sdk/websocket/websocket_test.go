package websocket

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type staticToken struct{}

func (staticToken) GetAccessToken(ctx context.Context) (string, error) { return "tok", nil }

// El servidor solo entrega trade_printed a las conexiones suscritas, así que
// el cliente debe declarar su suscripción en CADA conexión (vive en la
// conexión, no en el agente): aquí se verifica el envío en la conexión
// inicial y su re-envío automático tras una reconexión.
func TestSubscribeProductsSentOnEveryConnection(t *testing.T) {
	upgrader := websocket.Upgrader{}
	subs := make(chan []string, 4)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade falló: %v", err)
			return
		}
		defer conn.Close()
		var msg struct {
			Type       string   `json:"type"`
			ProductIDs []string `json:"product_ids"`
		}
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		if msg.Type == "subscribe_products" {
			subs <- msg.ProductIDs
		}
		// Cerrar fuerza la reconexión del cliente (backoff inicial 1 s).
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	c := NewClient(wsURL, staticToken{}, nil)
	c.SetProductSubscriptions([]string{"trigo", "pan"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start falló: %v", err)
	}
	defer c.Stop()

	for i := 1; i <= 2; i++ {
		select {
		case got := <-subs:
			if len(got) != 2 || got[0] != "trigo" || got[1] != "pan" {
				t.Fatalf("suscripción #%d inesperada: %v", i, got)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("timeout esperando subscribe_products #%d", i)
		}
	}
}
