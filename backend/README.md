# Backend API (contrato) — Seguimiento Oncogeriatría

Contrato del servidor que respalda el cliente offline-first. Se deriva
directamente del protocolo de sincronización implementado en
[`../js/sync.js`](../js/sync.js): el cliente encola operaciones en un *outbox* y
las envía en orden al reconectar; el servidor valida, aplica o rechaza cada una,
y resuelve los conflictos con lock optimista.

> Esto es un **contrato + servidor de referencia**, no un backend de producción.
> No hay autenticación real, persistencia ni integración con el BSP/Meta.

## Archivos

| Archivo | Qué es |
|---|---|
| [`openapi.yaml`](./openapi.yaml) | Especificación OpenAPI 3.1 del API |
| [`server.example.js`](./server.example.js) | Servidor de referencia ejecutable, sin dependencias (Node ≥ 18) |
| `package.json` | Scripts de arranque |

## Ejecutar el servidor de referencia

```bash
cd backend
npm start        # o: node server.example.js
# Reference backend escuchando en http://localhost:3000/v1
```

Pruebas rápidas:

```bash
curl "http://localhost:3000/v1/availability?fecha=2026-06-22"
curl "http://localhost:3000/v1/patients"

# Idempotencia: enviar dos veces el mismo client_id no duplica
curl -s -X POST http://localhost:3000/v1/sync -H 'Content-Type: application/json' -d '{
  "operations": [
    { "client_id": "op-1", "seq": 1, "op_type": "assessment.create", "created_local": "2026-06-16T10:00:00Z",
      "payload": { "assessment": { "client_id": "a-1", "paciente_id": "PT001", "paciente_nombre": "Rosa Méndez",
        "fecha": "2026-06-16", "estado_general": "mal", "sintomas_alarma": true, "adherencia": "no" } } }
  ]
}'
# -> status confirmed, clasificacion recalculada a "rojo", escalamiento en consola
```

## El protocolo de sincronización

### Endpoint central: `POST /v1/sync`

Recibe el lote de operaciones pendientes del cliente y devuelve un resultado por
cada una. El lote **nunca falla en bloque**: cada operación se resuelve de forma
independiente.

```jsonc
// Request
{ "operations": [ { "client_id": "...", "seq": 12, "op_type": "slot.reserve",
                    "created_local": "...", "payload": { ... } } ] }

// Response
{ "results": [ { "client_id": "...", "status": "confirmed",
                 "server_id": "...", "confirmed_server": "..." } ],
  "server_time": "..." }
```

`status` por operación:

| status | Significado | Acción del cliente |
|---|---|---|
| `confirmed` | Aplicada (o ya estaba aplicada) | Marca el registro `confirmado`, guarda `confirmed_server` |
| `conflict` | Requiere revisión manual | Mueve a la cola de conflictos; no sobrescribe |
| `rejected` | Inválida por regla de negocio | Marca `rechazado` con el motivo |

### Garantías (mapeadas al Plan §6.3)

1. **Idempotencia (§6.3.1).** Cada operación lleva `client_id` (UUID generado
   offline). El servidor guarda el resultado por `client_id`; un reintento
   devuelve el resultado previo sin volver a aplicar. → `db.processed` en el
   servidor de referencia.
2. **Orden (§6.3.2).** Las operaciones se procesan ordenadas por `seq`
   (creación), de modo que un `patient.create` precede a su `assessment.create`.
3. **Conflictos sin sobrescritura (§6.3.3).** `slot.reserve` usa
   `expected_version`. Si la versión del cupo en el servidor difiere, o el cupo
   ya está reservado por otro paciente, se devuelve `conflict` y va a
   `GET /v1/conflicts` para decisión humana.
4. **Notificaciones validadas (§6.3.4).** `notification.enqueue` se valida antes
   de enviar: consentimiento vigente + sin opt-out + la cita asociada sigue
   activa. Si falla, `rejected` (no se dispara el mensaje).
5. **Doble sello de tiempo (§6.3.5).** Se conserva `created_local` (cliente) y
   `confirmed_server` (servidor) para trazabilidad clínica y legal.

### Tipos de operación

| `op_type` | payload | Semántica del servidor |
|---|---|---|
| `assessment.create` | `{ assessment }` | Persiste; **recalcula `clasificacion`** (autoridad del servidor) y **escala banderas rojas de inmediato** (§5.3) |
| `patient.create` / `patient.update` | `{ patient }` | Upsert por `client_id` |
| `slot.reserve` | `{ slot_id, paciente_id, expected_version }` | Lock optimista; incrementa `version` al confirmar |
| `notification.enqueue` | `{ notification }` | Valida consentimiento/ventana/vigencia; al confirmar, dispara la plantilla Meta vía BSP |
| `note.create` | `{ note }` | Nota interna del paciente |

## Correspondencia cliente ↔ servidor

El servidor de referencia replica intencionalmente la lógica del cliente para que
el contrato quede inequívoco:

| Cliente (`js/sync.js`) | Servidor (`server.example.js`) |
|---|---|
| `Sync.enqueue(op_type, payload)` | cuerpo de `POST /v1/sync` |
| `validate(op)` | `validate(op)` |
| `apply(op)` | `apply(op, confirmed_server)` |
| `Sync.processOutbox()` | `syncBatch(operations)` |
| cola de `conflicts` | `db.conflicts` + `GET /v1/conflicts` |

## Pasos hacia producción

- Reemplazar el almacén en memoria por una base de datos transaccional; envolver
  cada operación en una transacción y aplicar el lock optimista a nivel de fila.
- Autenticación (JWT por usuario de enfermería) y autorización por rol.
- Integración real con el BSP (WATI/Botmaker/Treble) para `notification.enqueue`,
  respetando la ventana de 24 h y las plantillas pre-aprobadas (Plan §3).
- Webhooks de mensajes entrantes del paciente → crear/actualizar valoraciones.
- Auditoría append-only de todas las operaciones (trazabilidad Ley 1581).
- Exportación estructurada hacia el HIS/EHR (Plan §8 Fase 4).
