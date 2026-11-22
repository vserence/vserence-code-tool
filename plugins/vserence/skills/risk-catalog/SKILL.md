---
name: risk-catalog
description: Core risk catalog by domain (file uploads and media, payments, auth, data migrations, integrations and feeds, queues and jobs, concurrency, caches, deploy and maintenance). Each item - symptom, cause, prevention, test. Read by risk-analyst and reviewer for the touched domains.
user-invocable: false
---

# Каталог рисков ядра

Каталог не зависит от языка. Читай только файлы затронутых доменов:

| Домен | Файл | Когда затронут |
| --- | --- | --- |
| загрузка файлов и медиа | `file-uploads.md` | приём, хранение, обработка файлов, фото, видео, PDF |
| платежи | `payments.md` | оплата, возвраты, баланс, вебхуки платёжки |
| авторизация и права | `auth.md` | вход, сессии, токены, роли, доступ к объектам |
| миграции данных | `migrations.md` | схема БД, перенос и преобразование данных |
| внешние интеграции и фиды | `integrations-feeds.md` | вызовы внешних API, импорт фидов, вебхуки |
| очереди и фоновые задачи | `queues-jobs.md` | очереди, воркеры, cron, отложенные задачи |
| конкурентный доступ | `concurrency.md` | одновременное изменение одних данных |
| кэши | `caches.md` | любой кэш: память, Redis, CDN, HTTP |
| выкладка и обслуживание | `deploy-ops.md` | изменения, влияющие на выкладку, остановку, конфиг |

Формат каждого пункта: **Симптом** · **Причина** · **Как предотвратить** · **Как проверить тестом**.
Каждый применимый пункт в `risks-analysis.md` становится тестом или явно помечается как непокрытый с обоснованием.

Рост каталога: `/vserence:postmortem` добавляет пункт в `.vserence/risks.md` проекта; риск, не связанный с конкретным проектом, предлагается сюда через PR в репозиторий плагина.
