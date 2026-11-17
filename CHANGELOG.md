# Changelog

Все заметные изменения проекта **jstu4-ng** фиксируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
а версионирование следует [Semantic Versioning 2.0.0](https://semver.org/lang/ru/).
Сообщения коммитов и заголовки PR придерживаются спецификации
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

## [Unreleased]

### Changed

- Проект переименован в **jstu4-ng** (`https://github.com/Blezz-tech/jstu4-ng`), обновлены сведения об авторстве (`Blezz-tech`, с сохранением указания оригинального `jstu4` © Алексей Дубинин по лицензии MIT) и добавлен файл `LICENSE`.
- Версия в интерфейсе (`TM_VERSION`) теперь автоматически подставляется из `package.json` на этапе сборки (единый источник истины SemVer).
- Добавлена проверка Conventional Commits 1.0.0 (`npm run lint:commits` и job `Conventional Commits` в CI).

## [3.0.0] - 2026-11-14

### Added

- Современная переработка оригинального [jstu4 v2.3](https://github.com/lxyd/jstu4) на строгом TypeScript и нативном DOM без рантайм-зависимостей.
- Выполнение программ на плоских `TypedArray`-байткод-таблицах, zero-copy `O(k)` обновления ленты, SoA-кольцевой буфер истории до 100 000 шагов (`←` шаг назад и обратный автозапуск), оконная виртуализация больших лент и программ.
- Панель контроля версий (ручные снимки, автосохранения, переименование, фильтр «только именованные», восстановление, подтверждение удаления) и сворачиваемая боковая панель уведомлений/статистики/подсказок.
- Двуязычный интерфейс (RU/EN) с ICU-форматтером на `Intl`, светлая/тёмная/авто-тема на CSS `@layer` и `light-dark()`, Web Audio звук шагов, экспорт в формат TU4 в модальном окне.
- Сборка Vite 7 (`build:prod` / `build:dev`) с поддержкой прямого запуска по `file://`, наборы тестов Vitest и Playwright E2E, GitHub Actions CI и деплой на GitHub Pages.

[Unreleased]: https://github.com/Blezz-tech/jstu4-ng/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/Blezz-tech/jstu4-ng/releases/tag/v3.0.0
