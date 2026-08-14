# Signal Room

Pipeline multi-agente que convierte comentarios de redes sociales en briefs de campaña aprobados.

## Reglas de arquitectura (no negociables)

- Los agentes se comunican SOLO vía el objeto `CampaignState` validado con Zod.
  Nunca pasar texto libre entre agentes.
- Todo output de LLM se valida contra su schema Zod antes de persistirse.
  Si falla, reintentar una vez con el error inyectado en el prompt; si vuelve a
  fallar, marcar la campaña como `needs_human` y detener el pipeline.
- Toda corrida de agente escribe una fila en `agent_events`. Sin excepción.
- Las API keys solo se usan en Route Handlers del servidor.
  Nunca importar un SDK de LLM en un componente cliente.

## Independencia de proveedor

El proyecto NO depende de ningún proveedor de LLM en particular. Toda llamada a
un modelo pasa por `lib/llm/provider.ts`, que expone dos funciones:

```ts
complete({ task, prompt, schema }): Promise<T>   // generación estructurada
embed(texts: string[]): Promise<number[][]>       // embeddings
```

Reglas para esta capa:

- El proveedor activo se elige con `LLM_PROVIDER` y `EMBEDDING_PROVIDER` en el
  entorno. Agregar un proveedor nuevo significa escribir un adaptador, no tocar
  ningún agente.
- Los agentes declaran un `task` semántico (`"reasoning"` | `"extraction"` |
  `"drafting"`), nunca un nombre de modelo. El mapeo task → modelo vive en la
  config del proveedor.
- El `EMBEDDING_DIM` se lee del entorno porque varía por proveedor. La columna
  vector de Postgres se genera a partir de ese valor; no hardcodear 1024.
- Manejar 429 con backoff exponencial (1s, 2s, 4s) y un máximo de 3 intentos.
  Los tiers gratuitos tienen rate limits agresivos y esto no es opcional.
- Registrar `provider` y `model` en cada fila de `agent_events`, para poder
  comparar calidad y latencia entre proveedores después.

### Proveedores soportados

| Proveedor | Uso | Notas |
|---|---|---|
| Groq | generación | Tier gratis sin tarjeta. Muy rápido. Límites a nivel organización. |
| Google Gemini | generación y embeddings | Tier gratis sin tarjeta. En el tier gratis los datos pueden usarse para entrenar. |
| Ollama | embeddings (y generación local) | Corre local, sin límites ni costo, los datos no salen de la máquina. |
| Anthropic / OpenAI | generación | De pago. Adaptadores incluidos para poder comparar calidad. |

**Regla de datos:** nada de contenido real de usuarios se manda a un tier gratuito
que pueda usarse para entrenamiento. El seed de desarrollo es sintético.

## Convenciones

- Server Components por defecto; `"use client"` solo donde haya interactividad.
- Los schemas Zod viven en `lib/schemas.ts` y son la única fuente de verdad de tipos.
- Los prompts viven en `lib/agents/prompts/` como archivos separados, no inline.
  Deben ser neutrales de proveedor: sin sintaxis específica de ningún SDK.
- Sin `any`. Sin `console.log` en código que se commitea.

## Comandos

- `pnpm dev` — servidor de desarrollo
- `pnpm db:push` — aplicar schema
- `pnpm seed` — generar comentarios de prueba
- `pnpm eval` — correr el pipeline contra el set de prueba con el proveedor activo

## Variables de entorno

```
LLM_PROVIDER=groq            # groq | gemini | ollama | anthropic | openai
EMBEDDING_PROVIDER=ollama    # ollama | gemini | openai
EMBEDDING_DIM=768

GROQ_API_KEY=
GEMINI_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434
DATABASE_URL=
```