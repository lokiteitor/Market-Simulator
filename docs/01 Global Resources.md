# 01_Global_Resources.md

> **Proyecto:** Logistics World (Nombre provisional)
>
> **Versión:** 0.1
>
> **Estado:** Draft
>
> **Documento:** Catálogo Global de Recursos
>
> **Dependencias:** GDD Core

---

# 1. Objetivo

Este documento define todos los recursos naturales y materiales básicos existentes dentro del mundo.

Todo producto del juego debe poder rastrearse hasta uno o varios recursos de este documento.

No existen recursos infinitos generados artificialmente.

Toda la economía nace aquí.

---

# 2. Filosofía del Sistema

El diseño económico sigue seis principios fundamentales.

## 2.1 Todo tiene un origen

Todo objeto producido en el juego proviene de recursos naturales.

Ejemplo:

```
Hierro

↓

Acero

↓

Vigas

↓

Fábrica

↓

Motor

↓

Camión
```

Nunca existen productos "mágicos".

---

## 2.2 Todo necesita transporte

Los recursos nunca se teletransportan.

Cada movimiento requiere infraestructura logística.

Ejemplo:

```
Mina

↓

Camión

↓

Terminal Ferroviaria

↓

Tren

↓

Puerto

↓

Barco

↓

Puerto

↓

Camión

↓

Fábrica
```

---

## 2.3 Todo recurso debe tener múltiples usos

Se evita que existan recursos utilizados únicamente para fabricar un único producto.

Ejemplo:

**Hierro**

Produce:

- Acero estructural
- Acero inoxidable
- Maquinaria
- Vehículos
- Infraestructura

---

## 2.4 Las cadenas industriales deben ser profundas

Un producto complejo requiere múltiples etapas.

Ejemplo:

```
Petróleo

↓

Refinería

↓

Plástico

↓

Polímeros

↓

Panel interior

↓

Automóvil
```

---

## 2.5 Toda industria consume algo

No existen industrias independientes.

Cada edificio requiere entradas.

Ejemplo

Refinería

Entrada

- Petróleo

Salida

- Gasolina
- Diesel
- Químicos
- Asfalto
- Plásticos

---

## 2.6 Nada desaparece

Todo material producido termina en alguno de estos estados:

- almacenado
- transportado
- consumido
- utilizado como materia prima

---

# 3. Clasificación Global

Todos los recursos pertenecen a una familia logística.

Esta clasificación determina:

- vehículo compatible
- almacén
- estación
- puerto
- velocidad de carga
- costo logístico

---

## 3.1 Granel Sólido

Transportado sin empaquetar.

Ejemplos

- Hierro
- Carbón
- Arena
- Piedra
- Caliza
- Bauxita
- Litio
- Cobre
- Uranio
- Fosfato
- Sal
- Trigo
- Maíz
- Soya

Vehículos

- Camión Volteo
- Tolva ferroviaria
- Barco granelero

---

## 3.2 Granel Líquido

Ejemplos

- Petróleo
- Agua
- Gasolina
- Diesel
- Queroseno
- Aceites
- Productos químicos

Vehículos

- Camión cisterna
- Vagón tanque
- Petrolero

---

## 3.3 Carga General

Mercancía embalada.

Ejemplos

- Acero
- Madera
- Cemento
- Papel
- Vidrio
- Fertilizantes

Vehículos

- Camión caja
- Vagón cerrado
- Buque multipropósito

---

## 3.4 Contenedores

Productos manufacturados.

Ejemplos

- Electrónica
- Componentes
- Motores
- Electrodomésticos
- Maquinaria

Vehículos

- Camión portacontenedores
- Tren intermodal
- Buque portacontenedores

---

## 3.5 Refrigerados

Ejemplos

- Carne
- Leche
- Queso
- Frutas
- Verduras

Vehículos refrigerados.

---

## 3.6 Sobredimensionados

Ejemplos

- Turbinas
- Locomotoras
- Excavadoras
- Generadores
- Transformadores

Vehículos especiales.

---

# 4. Nivel 1 - Recursos Naturales

Los recursos naturales son generados únicamente durante la creación del mundo.

No pueden fabricarse.

Su distribución depende del mapa procedural.

---

# 4.1 Recursos Mineros

## Hierro

Tipo

Mineral

Familia logística

Granel sólido

Obtención

Mina de hierro

Usos

- Acero
- Acero inoxidable

---

## Carbón

Tipo

Mineral

Familia

Granel sólido

Obtención

Mina de carbón

Usos

- Acero
- Energía
- Industria química

---

## Cobre

Tipo

Mineral

Usos

- Cableado
- Electrónica
- Motores eléctricos

---

## Bauxita

Usos

- Aluminio

---

## Litio

Usos

- Baterías
- Electrónica
- Vehículos eléctricos (futuro)

---

## Níquel

Usos

- Acero inoxidable
- Aleaciones
- Baterías

---

## Oro

Usos

- Electrónica
- Circuitos

---

## Plata

Usos

- Electrónica
- Conductores

---

## Uranio

Usos

- Combustible nuclear

---

## Arena

Usos

- Vidrio
- Hormigón

---

## Piedra

Usos

- Construcción
- Asfalto

---

## Caliza

Usos

- Cemento
- Industria química

---

## Arcilla

Usos

- Ladrillos
- Cerámica

---

## Fosfato

Usos

- Fertilizantes

---

## Sal

Usos

- Industria química
- Alimentación

---

# 4.2 Recursos Energéticos

## Petróleo

Tipo

Líquido

Familia

Granel líquido

Obtención

Pozo petrolero

Usos

- Gasolina
- Diesel
- Queroseno
- Asfalto
- Plásticos
- Lubricantes
- Productos químicos

---

## Gas Natural

Obtención

Pozo de gas

Usos

- Fertilizantes
- Energía
- Químicos

---

## Agua

Obtención

Ríos

Lagos

Embalses

Usos

- Agricultura
- Industria
- Hormigón
- Alimentación

---

# 4.3 Recursos Forestales

## Troncos

Obtención

Bosques

Plantaciones

Usos

- Tablas
- Papel
- Cartón
- Biomasa

---

# 4.4 Recursos Agrícolas

## Trigo

Usos

- Harina
- Pan
- Pasta

---

## Maíz

Usos

- Alimentos
- Piensos
- Aceites

---

## Soya

Usos

- Aceite vegetal
- Piensos

---

## Algodón

Usos

- Textiles

---

## Caña de azúcar

Usos

- Azúcar
- Biocombustibles (futuro)

---

## Café

Usos

- Bebidas

---

## Cacao

Usos

- Chocolate

---

## Frutas

Usos

- Consumo
- Conservas

---

## Verduras

Usos

- Consumo
- Conservas

---

# 4.5 Recursos Ganaderos

## Ganado Bovino

Usos

- Carne
- Cuero
- Lácteos

---

## Cerdos

Usos

- Carne

---

## Pollos

Usos

- Carne

---

## Leche

Usos

- Queso
- Mantequilla
- Yogur

---

## Lana

Usos

- Textiles

---

# 5. Nivel 2 - Materiales Básicos

Los materiales básicos representan la primera transformación industrial de un recurso natural.

---

# 5.1 Metalurgia

## Acero

Entrada

- Hierro
- Carbón

Salida

- Acero

Usado por

- Construcción
- Vehículos
- Infraestructura
- Maquinaria

---

## Acero inoxidable

Entrada

- Acero
- Níquel

---

## Aluminio

Entrada

- Bauxita

---

## Cobre refinado

Entrada

- Mineral de cobre

---

# 5.2 Materiales de Construcción

## Cemento

Entrada

- Caliza

---

## Hormigón

Entrada

- Cemento
- Arena
- Agua

---

## Vidrio

Entrada

- Arena

---

## Ladrillos

Entrada

- Arcilla

---

## Asfalto

Entrada

- Petróleo
- Piedra

---

# 5.3 Industria Química

## Plástico

Entrada

- Petróleo

---

## Caucho Sintético

Entrada

- Petróleo

---

## Fertilizantes

Entrada

- Gas Natural
- Fosfato

---

## Productos Químicos

Entrada

- Petróleo
- Sal

---

# 5.4 Industria Forestal

## Tablas

Entrada

- Troncos

---

## Papel

Entrada

- Troncos

---

## Cartón

Entrada

- Papel

---

# 5.5 Alimentación

## Harina

Entrada

- Trigo

---

## Azúcar

Entrada

- Caña de azúcar

---

## Aceite vegetal

Entrada

- Soya

---

## Carne Procesada

Entrada

- Ganado
- Cerdos
- Pollos

---

## Lácteos

Entrada

- Leche

---

# 5.6 Combustibles

## Gasolina

Entrada

- Petróleo

---

## Diesel

Entrada

- Petróleo

---

## Queroseno

Entrada

- Petróleo

---

## Lubricantes

Entrada

- Petróleo

---

# 6. Dependencias Globales

```text
RECURSOS NATURALES
│
├── Minería
│   ├── Hierro
│   ├── Carbón
│   ├── Cobre
│   ├── Bauxita
│   ├── Litio
│   ├── Níquel
│   ├── Oro
│   ├── Plata
│   ├── Uranio
│   ├── Arena
│   ├── Piedra
│   ├── Caliza
│   ├── Arcilla
│   ├── Fosfato
│   └── Sal
│
├── Energía
│   ├── Petróleo
│   ├── Gas Natural
│   └── Agua
│
├── Forestal
│   └── Troncos
│
├── Agricultura
│   ├── Trigo
│   ├── Maíz
│   ├── Soya
│   ├── Algodón
│   ├── Caña de azúcar
│   ├── Café
│   ├── Cacao
│   ├── Frutas
│   └── Verduras
│
└── Ganadería
    ├── Bovinos
    ├── Cerdos
    ├── Pollos
    ├── Leche
    └── Lana

↓

MATERIALES BÁSICOS

├── Acero
├── Aluminio
├── Cobre refinado
├── Cemento
├── Hormigón
├── Vidrio
├── Ladrillos
├── Asfalto
├── Plástico
├── Caucho sintético
├── Fertilizantes
├── Productos químicos
├── Tablas
├── Papel
├── Cartón
├── Harina
├── Azúcar
├── Aceite vegetal
├── Carne procesada
├── Lácteos
├── Gasolina
├── Diesel
├── Queroseno
└── Lubricantes
```

---

# 7. Reglas de Balance

- Ningún recurso natural debe tener un único uso.
- Todo material básico debe alimentar al menos dos industrias diferentes.
- Ningún recurso natural puede fabricarse.
- La distribución de recursos es fija durante la vida del servidor.
- Los yacimientos son finitos o renovables según su naturaleza (este comportamiento se definirá en el documento de simulación del mundo).
- Todo recurso debe pertenecer exactamente a una familia logística.
- Cada recurso tendrá atributos adicionales definidos en documentos posteriores:
  - Unidad de medida (t, m³, L, unidades, etc.).
  - Densidad.
  - Valor base.
  - Tiempo de carga y descarga.
  - Compatibilidad con tipos de almacén y vehículos.

---
