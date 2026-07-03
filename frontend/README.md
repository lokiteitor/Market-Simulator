# Frontend — Mercado Agrícola

Interfaz web cliente para participantes humanos de la simulación, definida en
[`docs/system_design.md`](../docs/system_design.md). Consume la misma API que los agentes
automatizados (contrato en [`specs/openapi.yaml`](../specs/openapi.yaml)) a través de APISIX
(`http://localhost:9080/v1`, WebSocket en `/v1/ws`).

**Estado: pendiente de implementación** (fase posterior al backend). Reglas clave para cuando
se implemente:

- Nunca mostrar enteros crudos de la API: cantidades y dinero llegan en centésimas/centavos
  (dividir entre 100, mostrar 2 decimales).
- IDs UUIDv7 truncados (8-12 chars) con opción de copiar el completo.
- Reconexión silenciosa: revalidar token y resincronizar con `GET /v1/agents/me`, sin recargar.
- Errores RFC 7807: mostrar `errors[].message` junto al campo correspondiente (422).
