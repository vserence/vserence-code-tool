---
name: standards-api
description: API checklist (Google API Design Guide) - resource model, single error format (code, message, details, request id), pagination from day one, backward compatibility and versioning, idempotent creates. Use when a task changes HTTP/RPC APIs, webhooks or exchange formats.
user-invocable: false
---

# Стандарт API

## Принципы
1. Ресурсная модель: существительные-ресурсы и стандартные методы (List, Get, Create, Update, Delete); нестандартное действие — явный custom-метод.
2. Единый формат ошибок: код, сообщение, детали, id запроса — во всех ответах с ошибкой.
3. Пагинация с первого дня у каждого List: лимит размера страницы и токен/курсор следующей страницы.
4. Обратная совместимость: поля не удаляются, не переименовываются и не меняют тип в рамках версии; ломающее изменение = новая версия.
5. Идемпотентные создания: Create принимает ключ идемпотентности или клиентский id; повтор возвращает тот же ресурс.
6. Вход проверяется по схеме на границе (типы, обязательность, длины, диапазоны); неизвестные поля не ломают сервер.

## Как проверить
- [ ] Новые эндпоинты названы по ресурсам; метод соответствует действию (GET без побочных эффектов).
- [ ] Тест на ошибочный запрос проверяет все 4 поля ошибки, включая id запроса.
- [ ] Каждый новый List имеет `page_size` с максимумом и `next_page_token`/курсор; тест на вторую страницу.
- [ ] Diff схемы/контракта (OpenAPI, proto, JSON Schema): нет удалённых/переименованных/сменивших тип полей в существующей версии.
- [ ] Тест: два одинаковых Create с одним ключом → один ресурс, одинаковый ответ.
- [ ] Валидация входа по схеме, тест на неверный тип и превышение длины.

## Антипаттерны
- `POST /doSomething` для всего; глаголы в путях ресурсов.
- Разный формат ошибок в разных эндпоинтах; 200 с `{"error": ...}`.
- List без пагинации («потом добавим»).
- Тихое изменение смысла существующего поля.

## Плохо / хорошо
```text
ПЛОХО:
  GET /getOrders            -> 200 [ ...все 50 000 заказов ]
  ошибка                     -> 200 {"ok": false, "msg": "bad"}
ХОРОШО:
  GET /v1/orders?page_size=50&page_token=abc -> 200 {"orders":[...], "next_page_token":"def"}
  ошибка -> 400 {"error":{"code":"INVALID_ARGUMENT","message":"page_size must be <= 100",
                         "details":[{"field":"page_size"}],"request_id":"r-123"}}
```

## Первоисточники
Google API Design Guide (cloud.google.com/apis/design): resource-oriented design, standard methods, errors, pagination, compatibility, versioning.
