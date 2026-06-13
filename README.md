```text
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗  
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝

███████╗███████╗██████╗ ██╗   ██╗███████╗██████╗ 
██╔════╝██╔════╝██╔══██╗██║   ██║██╔════╝██╔══██╗
███████╗█████╗  ██████╔╝██║   ██║█████╗  ██████╔╝
╚════██║██╔══╝  ██╔══██╗╚██╗ ██╔╝██╔══╝  ██╔══██╗
███████║███████╗██║  ██║ ╚████╔╝ ███████╗██║  ██║
╚══════╝╚══════╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝
```

# claude-server

HTTP-обёртка над [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) с поддержкой стриминга и OpenAI-совместимым API.

## Требования

- [Bun](https://bun.sh) ≥ 1.2.0
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` доступен в `PATH`)

## Установка и запуск

```bash
bun install

# Разработка с hot-reload
bun run dev

# Продакшн
bun run start
```

Сервер стартует на `http://localhost:4317` (или на порту из `PORT`).

## Конфигурация

Скопируй `.env.example` в `.env` и настрой переменные:

```bash
cp .env.example .env
```

| Переменная            | По умолчанию         | Описание                                            |
|-----------------------|----------------------|-----------------------------------------------------|
| `PORT`                | `4317`               | HTTP-порт сервера                                   |
| `CLAUDE_BIN`          | `claude`             | Путь к бинарю Claude Code CLI                       |
| `CLAUDE_DEFAULT_MODEL`| `claude-sonnet-4-6`  | Модель по умолчанию                                 |
| `CLAUDE_TIMEOUT_MS`   | `300000`             | Таймаут одного запроса к Claude (мс)                |
| `CLAUDE_CWD`          | —                    | Рабочая директория для Claude                       |
| `API_TOKEN`           | —                    | Bearer-токен для аутентификации (отключена если не задан) |
| `CORS_ORIGINS`        | `*`                  | Разрешённые CORS-origins (через запятую)            |

## API

### `GET /health`
Проверяет доступность Claude CLI.

### `GET /v1/models`
Список поддерживаемых моделей в формате OpenAI.

### `POST /v1/run`
Однократный запрос к Claude.

**Тело запроса:**

| Поле                | Тип      | Описание                                                  |
|---------------------|----------|-----------------------------------------------------------|
| `prompt`            | `string` | Текст запроса (обязательно)                               |
| `model`             | `string` | Модель (по умолчанию из `CLAUDE_DEFAULT_MODEL`)           |
| `systemPrompt`      | `string` | Системный промпт                                          |
| `appendSystemPrompt`| `string` | Дополнение к системному промпту                           |
| `allowedTools`      | `string` | Разрешённые инструменты для Claude CLI                    |
| `disallowedTools`   | `string` | Запрещённые инструменты                                   |
| `cwd`               | `string` | Рабочая директория для этого запроса                      |
| `timeoutMs`         | `number` | Таймаут запроса (мс, макс. 1 800 000)                     |
| `resumeSession`     | `string` | ID сессии для продолжения диалога (см. ниже)              |

**Ответ** содержит поле `sessionId` — сохрани его, чтобы продолжить диалог:

```json
{
  "result": "Привет! Чем могу помочь?",
  "sessionId": "01abc123...",
  "model": "claude-sonnet-4-6",
  "durationMs": 1234,
  "costUsd": 0.0003,
  "usage": { "inputTokens": 10, "outputTokens": 20 }
}
```

### `POST /v1/run/stream`
То же, но ответ приходит через SSE-поток (события `start`, `event`, `done`, `error`). Принимает те же поля, что и `/v1/run`, включая `resumeSession`.

`sessionId` текущей сессии доступен внутри события `event` с `type === "result"`:

```
event: event
data: {"type":"result","session_id":"01abc123...","result":"..."}
```

## Многоходовые диалоги (сессии)

Claude Code CLI хранит историю каждого запроса под уникальным `sessionId`. Передав его в следующем запросе через `resumeSession`, сервер возобновит диалог с тем же контекстом.

```bash
# Первый запрос
curl -X POST http://localhost:4317/v1/run \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Меня зовут Иван."}'
# → {"result": "Привет, Иван!", "sessionId": "01abc123...", ...}

# Продолжение — Claude помнит имя
curl -X POST http://localhost:4317/v1/run \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Как меня зовут?", "resumeSession": "01abc123..."}'
# → {"result": "Тебя зовут Иван.", ...}
```

Для стримингового эндпоинта `resumeSession` работает так же — передаётся в теле запроса к `/v1/run/stream`.

### `POST /v1/chat/completions`
OpenAI Chat Completions-совместимый эндпоинт. Работает с любым клиентом, поддерживающим OpenAI API (включая стриминг).

```bash
curl http://localhost:4317/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Привет!"}]
  }'
```

## Аутентификация

Если задан `API_TOKEN`, все запросы (кроме `/health`) должны содержать заголовок:

```
Authorization: Bearer <API_TOKEN>
```
