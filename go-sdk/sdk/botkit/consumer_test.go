package botkit

import (
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/state"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// Banco de pruebas de la demanda urbana (ADR-029) con un StateManager real, no
// un doble: lo que se prueba es que la ciudad compra CONTRA SU NECESIDAD (la que
// le da el servidor) y contra su stock, y que la vivienda va por su propio
// carril. Los precios son los del catálogo real, porque el precio de reserva se
// ancla a ellos.
const (
	idPan      = "p-pan"
	idQueso    = "p-queso"
	idVivienda = "p-vivienda"
	agenteCity = "a-city"
)

const (
	precioPan      = 190
	precioQueso    = 2365
	precioVivienda = 453100
)

type relojFijo struct{ t time.Time }

func (r relojFijo) Now() time.Time { return r.t }

// mercadoFalso sirve el mismo ask para todos los productos y una necesidad fija.
// `errNeeds` simula un servidor que no expone /city-needs (403 o versión vieja).
type mercadoFalso struct {
	ask      *models.TopOfBookSide
	needs    *models.CityNeeds
	errNeeds error
	llamadas int
}

func (m *mercadoFalso) TopOfBook(productID string) (*models.TopOfBook, error) {
	return &models.TopOfBook{ProductID: productID, BestAsk: m.ask}, nil
}

func (m *mercadoFalso) RecentTrades(string, models.TradesQuery) ([]models.Trade, error) {
	return nil, nil
}

func (m *mercadoFalso) BankInfo() (*models.BankInfo, error) {
	return nil, errors.New("no_gold_standard")
}

func (m *mercadoFalso) CityNeeds() (*models.CityNeeds, error) {
	m.llamadas++
	if m.errNeeds != nil {
		return nil, m.errNeeds
	}
	return m.needs, nil
}

type opciones struct {
	capital     int64
	poblacion   int64
	inventario  map[string]int64
	ordenes     []models.Order
	needs       *models.CityNeeds
	errNeeds    error
	ask         *models.TopOfBookSide
	sinUrbanRol bool
}

func productoUrbano(id, key string, rol models.UrbanRole, coste int64) models.Product {
	return models.Product{
		ProductID:          id,
		Key:                key,
		Name:               key,
		Unit:               "unidad",
		Category:           models.CategoryFinalConsumption,
		ReferenceCostCents: coste,
		UrbanRole:          rol,
	}
}

// necesidad construye la respuesta de /city-needs con las cantidades dadas.
func necesidad(poblacion int64, porProducto map[string]int64) *models.CityNeeds {
	needs := make([]models.CityNeed, 0, len(porProducto))
	for id, qty := range porProducto {
		needs = append(needs, models.CityNeed{ProductID: id, ProductKey: id, QtyCentPerPeriod: qty})
	}
	return &models.CityNeeds{Population: poblacion, PeriodSimSeconds: 50, Needs: needs}
}

func contextoCiudad(t *testing.T, o opciones) (*strategy.Context, *mercadoFalso) {
	t.Helper()

	rolPan, rolQueso := models.UrbanRoleBasket, models.UrbanRoleBasket
	rolVivienda := models.UrbanRoleHousing
	if o.sinUrbanRol {
		// Servidor anterior a ADR-029: la categoría es lo único que llega.
		rolPan, rolQueso, rolVivienda = "", "", ""
	}
	st := state.NewStateManager()
	st.SetCatalog(
		[]models.Product{
			productoUrbano(idPan, "pan", rolPan, precioPan),
			productoUrbano(idQueso, "queso", rolQueso, precioQueso),
			productoUrbano(idVivienda, "vivienda", rolVivienda, precioVivienda),
		},
		nil,
	)

	inv := make([]models.InventoryPosition, 0, len(o.inventario))
	for id, qty := range o.inventario {
		inv = append(inv, models.InventoryPosition{ProductID: id, QtyAvailableCent: qty})
	}
	poblacion := o.poblacion
	capital := o.capital
	if capital == 0 {
		capital = 10_000_000
	}
	st.Rebuild(&models.AgentSnapshot{
		Agent: models.AgentPublic{
			AgentID: agenteCity, Username: "tokyo",
			Role: models.RoleCity, Status: models.StatusActive,
		},
		CapitalAvailableCents: capital,
		Population:            &poblacion,
		Inventory:             inv,
		ActiveOrders:          o.ordenes,
	})

	mercado := &mercadoFalso{ask: o.ask, needs: o.needs, errNeeds: o.errNeeds}
	if mercado.needs == nil && mercado.errNeeds == nil {
		mercado.needs = necesidad(poblacion, map[string]int64{idPan: 500, idQueso: 40})
	}
	return &strategy.Context{
		State:  st,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Rand:   rand.New(rand.NewPCG(1, 2)),
		Clock:  relojFijo{t: time.Unix(1_700_000_000, 0)},
		Config: map[string]interface{}{
			"sim_time_factor": 5.0,
			"prices": map[string]interface{}{
				"pan": precioPan, "queso": precioQueso, "vivienda": precioVivienda,
			},
			// Se fija para que los tests no dependan del muestreo por bot.
			"market": map[string]interface{}{"consumer_per_tick": 3},
		},
		Market: mercado,
	}, mercado
}

func nuevaCiudad(t *testing.T, ctx *strategy.Context) *ConsumerStrategy {
	t.Helper()
	s := NewConsumerStrategy()
	if err := s.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	return s
}

// ticksHasta corre la estrategia varias veces: el bot humaniza (skipTickProb,
// crossProb), así que un solo Tick no prueba nada.
func ticksHasta(t *testing.T, s *ConsumerStrategy, ctx *strategy.Context, intentos int) []actions.Action {
	t.Helper()
	var todas []actions.Action
	for i := 0; i < intentos; i++ {
		todas = append(todas, s.Tick(ctx)...)
	}
	return todas
}

func comprasDe(acts []actions.Action, productID string) []actions.PlaceOrder {
	var out []actions.PlaceOrder
	for _, a := range acts {
		if po, ok := a.(actions.PlaceOrder); ok && po.ProductID == productID {
			out = append(out, po)
		}
	}
	return out
}

// El papel urbano lo dicta el catálogo: la cesta y la vivienda no son listas
// locales del bot.
func TestInitialize_SeparaCestaDeVivienda(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{poblacion: 1000})
	s := nuevaCiudad(t, ctx)

	if len(s.basketProducts) != 2 {
		t.Fatalf("cesta = %v, se esperaban pan y queso", s.basketProducts)
	}
	if s.housingProduct != idVivienda {
		t.Fatalf("bien de inversión = %q, se esperaba la vivienda", s.housingProduct)
	}
}

// Degradación contra un servidor anterior a ADR-029: sin `urban_role` la cesta
// cae al comportamiento histórico (toda la categoría de consumo final).
func TestInitialize_SinUrbanRoleDegradaAConsumoFinal(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{poblacion: 1000, sinUrbanRol: true})
	s := nuevaCiudad(t, ctx)

	if len(s.basketProducts) != 3 {
		t.Fatalf("cesta = %v, se esperaban los 3 finales", s.basketProducts)
	}
	if s.housingProduct != "" {
		t.Fatalf("sin urban_role no debería haber bien de inversión, hay %q", s.housingProduct)
	}
}

// Lo esencial del cambio: la ciudad pide el HUECO entre su stock objetivo y lo
// que tiene, no una cantidad fija.
func TestTick_CompraElHuecoHastaElStockObjetivo(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{
		poblacion:  1000,
		inventario: map[string]int64{idPan: 100},
	})
	s := nuevaCiudad(t, ctx)

	acts := ticksHasta(t, s, ctx, 30)
	compras := comprasDe(acts, idPan)
	if len(compras) == 0 {
		t.Fatal("no compró pan teniendo la despensa por debajo del objetivo")
	}
	// objetivo = 500 × cobertura (3-8) ⇒ como mucho 4000; con 100 en stock, el
	// hueco nunca puede pedir más que eso.
	for _, c := range compras {
		if c.QtyCent > 500*8 {
			t.Fatalf("pidió %d, por encima del stock objetivo máximo", c.QtyCent)
		}
		if c.Side != models.SideBuy {
			t.Fatalf("una ciudad solo compra, y emitió %v", c.Side)
		}
	}
}

// La despensa llena es el freno: sin él la ciudad compraría sin parar y su
// inventario crecería indefinidamente (el problema que ADR-029 viene a cerrar).
func TestTick_NoCompraConLaDespensaLlena(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{
		poblacion: 1000,
		// 500 × 8 periodos de cobertura es el objetivo máximo posible.
		inventario: map[string]int64{idPan: 500 * 100, idQueso: 40 * 100},
	})
	s := nuevaCiudad(t, ctx)

	if acts := ticksHasta(t, s, ctx, 30); len(comprasDe(acts, idPan)) > 0 {
		t.Fatal("compró pan con la despensa muy por encima del objetivo")
	}
}

// Las órdenes ya colocadas cuentan como stock en camino: si no, la ciudad
// duplicaría la compra cada tick hasta agotar su capital.
func TestTick_CuentaLasOrdenesPendientesComoStock(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{
		poblacion: 1000,
		ordenes: []models.Order{{
			OrderID: "o-1", ProductID: idPan, Side: models.SideBuy,
			QtyPendingCent: 500 * 100, Status: models.OrderStatusActive,
		}},
	})
	s := nuevaCiudad(t, ctx)

	if acts := ticksHasta(t, s, ctx, 30); len(comprasDe(acts, idPan)) > 0 {
		t.Fatal("volvió a pedir pan teniendo ya el objetivo entero pendiente de compra")
	}
}

// Sin necesidad declarada la ciudad NO adivina: es el servidor quien dice qué se
// consume, y un producto con necesidad 0 no se compra.
func TestTick_NoCompraLoQueNoNecesita(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{
		poblacion: 1000,
		needs:     necesidad(1000, map[string]int64{idPan: 500}),
	})
	s := nuevaCiudad(t, ctx)

	acts := ticksHasta(t, s, ctx, 30)
	if len(comprasDe(acts, idQueso)) > 0 {
		t.Fatal("compró queso sin necesidad declarada por el servidor")
	}
	if len(comprasDe(acts, idPan)) == 0 {
		t.Fatal("no compró pan, que sí tenía necesidad")
	}
}

// Si /city-needs falla, la ciudad no debe entrar en pánico ni comprar a ciegas.
func TestTick_SinNecesidadDelServidorNoCompraCesta(t *testing.T) {
	ctx, mercado := contextoCiudad(t, opciones{
		poblacion: 1000,
		errNeeds:  errors.New("boom"),
	})
	s := nuevaCiudad(t, ctx)

	if acts := ticksHasta(t, s, ctx, 10); len(comprasDe(acts, idPan)) > 0 {
		t.Fatal("compró cesta sin conocer su necesidad")
	}
	if mercado.llamadas < 2 {
		t.Fatalf("debería reintentar el refresco; llamadas = %d", mercado.llamadas)
	}
}

// La vivienda es la inversión: se compra de una en una y solo cuando la cuota de
// capital reservada la cubre. Con capital de sobra debe intentarlo.
func TestTick_CompraViviendaCuandoElCapitalAlcanza(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{
		poblacion: 1000,
		capital:   50 * precioVivienda, // holgado para cualquier housing_share
	})
	s := nuevaCiudad(t, ctx)

	compras := comprasDe(ticksHasta(t, s, ctx, 30), idVivienda)
	if len(compras) == 0 {
		t.Fatal("no intentó comprar vivienda con capital de sobra")
	}
	for _, c := range compras {
		if c.QtyCent != 100 {
			t.Fatalf("la vivienda se compra de una en una (100 qty_cent), pidió %d", c.QtyCent)
		}
	}
}

// Sin capital para una vivienda entera, la ciudad AHORRA en vez de emitir una
// orden que el engine descartaría igualmente por no caber en su capital.
func TestTick_AhorraCuandoLaViviendaNoAlcanza(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{
		poblacion: 1000,
		capital:   precioVivienda / 2,
	})
	s := nuevaCiudad(t, ctx)

	if compras := comprasDe(ticksHasta(t, s, ctx, 30), idVivienda); len(compras) > 0 {
		t.Fatalf("pidió vivienda sin poder pagarla (%d órdenes)", len(compras))
	}
}

// No se apilan órdenes de vivienda: con una pendiente no se manda otra.
func TestTick_NoApilaOrdenesDeVivienda(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{
		poblacion: 1000,
		capital:   50 * precioVivienda,
		ordenes: []models.Order{{
			OrderID: "o-casa", ProductID: idVivienda, Side: models.SideBuy,
			QtyPendingCent: 100, Status: models.OrderStatusActive,
		}},
	})
	s := nuevaCiudad(t, ctx)

	if compras := comprasDe(ticksHasta(t, s, ctx, 30), idVivienda); len(compras) > 0 {
		t.Fatal("mandó una segunda orden de vivienda teniendo una pendiente")
	}
}

// Un ask por encima de la disposición a pagar no se levanta: la reserva está
// anclada al precio BASE, para que la demanda no persiga al precio hacia arriba.
func TestTick_NoPagaPorEncimaDeLaReserva(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{
		poblacion: 1000,
		ask:       &models.TopOfBookSide{PriceCents: precioPan * 10, QtyPendingCent: 100_000},
	})
	s := nuevaCiudad(t, ctx)

	for _, c := range comprasDe(ticksHasta(t, s, ctx, 30), idPan) {
		if c.LimitPriceCents > precioPan*2 {
			t.Fatalf("cotizó %d, muy por encima de su reserva (base %d)", c.LimitPriceCents, precioPan)
		}
	}
}

// La población escala todas las necesidades, así que un cambio invalida la
// necesidad cacheada y obliga a refrescarla.
func TestHandleEvent_PoblacionCambiadaRefrescaLaNecesidad(t *testing.T) {
	ctx, mercado := contextoCiudad(t, opciones{poblacion: 1000})
	s := nuevaCiudad(t, ctx)
	antes := mercado.llamadas

	s.HandleEvent(ctx, events.CityPopulationChanged{Population: 1004, HabitantsGained: 4})
	s.Tick(ctx)

	if mercado.llamadas <= antes {
		t.Fatal("no refrescó /city-needs tras cambiar la población")
	}
}

// La suscripción al tape cubre lo que la ciudad compra: cesta + vivienda.
func TestSubscribedProducts_CubreCestaYVivienda(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{poblacion: 1000})
	s := nuevaCiudad(t, ctx)

	subs := s.SubscribedProducts()
	if len(subs) != 3 {
		t.Fatalf("suscripciones = %v, se esperaban los 3 productos que compra", subs)
	}
}

// Un agente quebrado no opera (las ciudades están exentas, pero la guarda debe
// seguir ahí: es la que retira a un bot que el servidor ya cerró).
func TestTick_NoOperaEnQuiebra(t *testing.T) {
	ctx, _ := contextoCiudad(t, opciones{poblacion: 1000})
	s := nuevaCiudad(t, ctx)
	ctx.State.(*state.StateManager).ApplyEvent(events.BankruptcyNotice{AgentID: agenteCity})

	if acts := ticksHasta(t, s, ctx, 10); len(acts) > 0 {
		t.Fatalf("operó estando en quiebra: %d acciones", len(acts))
	}
}
