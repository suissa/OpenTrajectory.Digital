# API Reference

Esta referência descreve a superfície exportada por `src/index.ts` na versão atual. Todos os símbolos podem ser importados de `@opentrajectory/digital`.

## Vocabulário: Expansion e Expand

- `Expansion` é uma interface de dados: `id`, `label`, `timestamp`, `offsetMs` e `attributes`.
- `Expand(label, attributes?)` é uma função que registra uma Expansion no Track ativo da Trajectory corrente.
- `Expand` é um alias público de `TrajectoryContext.expand`.
- Quando não há Trajectory ou Track ativo, `Expand` retorna sem registrar nada. Não cria automaticamente uma execução.
- O offset é medido em milissegundos desde o início do Track, usando o relógio monotônico do processo. `timestamp` é uma data ISO-8601.

## Símbolos exportados

### Decorators e instrumentação

| Símbolo | Tipo | Contrato |
| --- | --- | --- |
| `Trajectory(options?)` | Class decorator | Define o nome padrão da Trajectory criada automaticamente por métodos `@Track` daquela classe. |
| `Track(options?)` | Method decorator | Instrumenta um método como Track. Preserva retorno sync/async, argumentos e `this`. |
| `Expand(label, attributes?)` | Function | Registra uma Expansion no Track ativo. |
| `CausalLink(fromTrackId, toTrackId, kind, attributes?)` | Function | Registra uma Relation no contexto ativo. Sem contexto ativo, não faz nada. |

`@Track` suporta decorators legacy e Stage 3. Para decorators legacy, habilite `experimentalDecorators`. Um método decorado chamado fora de uma Trajectory cria uma automaticamente; dentro de uma execução existente, cria um Track filho.

### Runtime e contexto

| Símbolo | Tipo | Contrato |
| --- | --- | --- |
| `TrajectoryRuntime` | Class | Cria execuções e expõe o contexto corrente. |
| `trajectoryRuntime` | Singleton | Instância padrão usada por `@Track` ao criar Trajectories automaticamente. |
| `TrajectoryContext` | Class | Contexto da execução atual, tracks, relações, snapshots e helpers estáticos. |
| `TrajectoryRuntime.trajectory(options, callback)` | Method | Executa callback e sempre retorna Promise. |
| `TrajectoryRuntime.trajectoryMaybe(options, callback)` | Method | Preserva retorno síncrono ou Promise do callback. |
| `TrajectoryRuntime.current()` | Method | Retorna o contexto corrente do runtime. |
| `TrajectoryContext.current()` | Static method | Retorna o contexto corrente propagado pelo AsyncLocalStorage. |
| `TrajectoryContext.expand(label, attributes?)` | Static method | Mesmo contrato de `Expand`. |
| `TrajectoryContext.relate(from, to, kind, attributes?)` | Static method | Mesmo contrato de `CausalLink`. |
| `TrajectoryContext.run(callback)` | Method | Executa callback e retorna Promise. |
| `TrajectoryContext.runMaybe(callback)` | Method | Preserva retorno sync/async e fecha a Trajectory. |
| `TrajectoryContext.track(options, callback)` | Method | Cria Track e retorna Promise. |
| `TrajectoryContext.trackMaybe(options, callback)` | Method | Cria Track preservando retorno sync/async. |
| `TrajectoryContext.relate(from, to, kind, attributes?)` | Method | Adiciona uma Relation ao snapshot da Trajectory. |
| `TrajectoryContext.snapshot()` | Method | Produz snapshot com cópias rasas de atributos e relações. |
| `TrajectoryContext.topologicalTracks()` | Method | Retorna Tracks em projeção topológica determinística sem reordenar o snapshot original. |

Os métodos `runMaybe` e `trackMaybe` existem para a implementação dos decorators preservar o contrato síncrono. Para uso normal, prefira `trajectory` e `track`, que retornam Promise.

### Exporters e adapters

| Símbolo | Tipo | Contrato |
| --- | --- | --- |
| `TrajectoryExporter` | Interface | Hooks opcionais para início/fim de Trajectory e Track e registro de Expansion. |
| `ConsoleTrajectoryExporter` | Class | Escreve lifecycle e resumo no console. |
| `OpenTelemetryAdapter` | Class | Adapta Tracks e Expansions para spans através de um tracer compatível. |
| `OpenTelemetryTracerLike` | Interface | Subconjunto estrutural de tracer necessário pelo adapter. |
| `OpenTelemetrySpanLike` | Interface | Subconjunto estrutural de span necessário pelo adapter. |

Hooks de exporter são síncronos. Exceções lançadas por um exporter não são isoladas pelo runtime e podem interromper a execução instrumentada. O adapter OpenTelemetry atual cria spans para Tracks, inclui IDs e atributos e encerra spans no fim do Track. O modelo atual não define parent span context explícito na interface estrutural.

### Tipos e contratos de dados

| Símbolo | Descrição |
| --- | --- |
| `AttributeValue` | `string | number | boolean | null`. |
| `Attributes` | Mapa de atributos string para AttributeValue. |
| `RelationKind` | `causes | depends_on | expands | follows | derives_from`. |
| `CausalRelationError` | Erro de validação com código, IDs e diagnóstico de ciclo. |
| `CausalRelationErrorCode` | União dos códigos de erro de relação causal. |
| `validateRelation(tracks, relations, relation)` | Valida uma aresta; retorna `false` quando ela já existe. |
| `topologicalTracks(snapshot)` | Projeta os Tracks em ordem topológica determinística. |
| `Relation` | Aresta direcionada entre dois Track IDs, com tipo e atributos opcionais. |
| `Expansion` | Registro de marco dentro de um Track. |
| `TrackSnapshot` | Estado observável de um Track, incluindo hierarquia, duração, atributos, expansions e erro. |
| `TrajectorySnapshot` | Estado observável da Trajectory, incluindo correlation ID, Tracks e relações. |
| `TrackOptions` | Opções de nome, atributos e IDs de causas para criar um Track. |
| `TrajectoryOptions` | Opções de nome, correlation ID, atributos e autoReport. |
| `RuntimeOptions` | Opções do runtime, incluindo exporters e autoReport. |

## Lifecycle

1. O runtime cria a Trajectory com estado `running` e emite `onTrajectoryStarted`.
2. Cada chamada de `track` cria um Track com sequência crescente e profundidade derivada do Track ativo; emite `onTrackStarted`.
3. `Expand` adiciona um marco ao Track ativo e emite `onExpansion`.
4. Ao concluir, o Track recebe `ok` ou `error`, timestamps e duração; emite `onTrackEnded`.
5. Ao concluir a callback principal, a Trajectory recebe `ok` ou `error`, timestamps e duração; emite `onTrajectoryEnded`.

Erros são propagados ao chamador. O Track registra nome e mensagem do erro. `startedAt`, `endedAt` e `Expansion.timestamp` são ISO-8601; durações e offsets são milissegundos monotônicos arredondados.

## Relações causais

Uma `Relation` é uma aresta direcionada: `fromTrackId` é a origem semântica e `toTrackId` é o destino. Todas as relações representam uma precedência/influência da origem para o destino:

| RelationKind | Semântica |
| --- | --- |
| `causes` | A origem causa o destino. |
| `depends_on` | O destino depende da origem. |
| `expands` | O destino expande ou detalha a origem. |
| `follows` | O destino ocorre depois da origem. |
| `derives_from` | O destino deriva da origem. |

A hierarquia `parentId`/ `depth` descreve contenção estrutural; ela não cria automaticamente uma Relation causal. São dimensões independentes.

`TrajectoryContext.relate()` e `CausalLink()` validam que ambos os IDs existem na mesma Trajectory, rejeitam autorrelações e rejeitam qualquer aresta que crie ciclo. Uma Relation repetida com a mesma origem, destino e tipo é idempotente (não duplica); o mesmo par de Tracks pode ter tipos diferentes de relação. `TrackOptions.causes` aplica a mesma validação para as relações criadas ao abrir um Track.

Erros de validação lançam `CausalRelationError`, que inclui `code`, IDs envolvidos e, quando disponível, caminho do ciclo. Códigos: `UNKNOWN_SOURCE_TRACK`, `UNKNOWN_TARGET_TRACK`, `SELF_RELATION` e `CAUSAL_CYCLE`.

`TrajectoryContext.topologicalTracks()` e a função exportada `topologicalTracks(snapshot)` retornam uma projeção topológica determinística. Desempates usam `sequence` original e depois ID. A projeção não altera `snapshot.tracks`: a ordem temporal original continua disponível. Snapshots externos inválidos também são verificados durante a projeção e ciclos causam `CausalRelationError`.

## Concorrência e isolamento

O contexto ativo é propagado por `AsyncLocalStorage`, portanto chamadas assíncronas e Trajectories concorrentes mantêm seus próprios contextos. A lista de Tracks e relações é acumulada na instância da Trajectory. Snapshots copiam os objetos de atributos de primeiro nível; valores aninhados não são permitidos pelo tipo `Attributes`.

## Compatibilidade e depreciação

Não há renomeação nem depreciação de `Expansion` ou `Expand`: são conceitos diferentes e complementares. Símbolos exportados são considerados API pública. Mudanças incompatíveis devem ser anunciadas em release notes e acompanhadas por período de depreciação quando tecnicamente viável.

## Roadmap — não disponível nesta versão

`Destination`, `Journey` e `Step` são termos reservados para possíveis modelos ou aliases futuros. Não são exportados e não possuem contrato implementado.
