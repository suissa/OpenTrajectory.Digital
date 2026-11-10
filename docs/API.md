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
| `TrajectoryContext.snapshot()` | Method | Produz snapshot com cópias defensivas de atributos, Expansions, erros e relações. |
| `TrajectoryContext.topologicalTracks()` | Method | Retorna Tracks em projeção topológica determinística sem reordenar o snapshot original. |

Os métodos `runMaybe` e `trackMaybe` existem para a implementação dos decorators preservar o contrato síncrono. Para uso normal, prefira `trajectory` e `track`, que retornam Promise.

### Exporters e adapters

| Símbolo | Tipo | Contrato |
| --- | --- | --- |
| `TrajectoryExporter` | Interface | Hooks opcionais para início/fim de Trajectory e Track, Expansion e Relation. |
| `ConsoleTrajectoryExporter` | Class | Escreve lifecycle e resumo no console. |
| `OpenTelemetryAdapter` | Class | Adapta Tracks e Expansions para spans através de um tracer compatível. |
| `OpenTelemetryTracerLike` | Interface | Subconjunto estrutural de tracer necessário pelo adapter. |
| `OpenTelemetrySpanLike` | Interface | Subconjunto estrutural de span necessário pelo adapter. |
| `OpenTelemetryContextBridgeLike` | Interface | Bridge opcional para criar parent contexts OTel sem dependência no core. |
| `OpenTelemetrySpanContextLike` | Interface | Identidade estrutural de um span usada em links. |
| `OpenTelemetrySpanLinkLike` | Interface | Link causal estrutural enviado na criação de spans. |
| `OpenTelemetrySpanOptionsLike` | Interface | Opções estruturais para atributos, links e timestamp inicial. |

Hooks de exporter são síncronos; a política de falhas e encerramento está descrita na seção “Snapshots, exporters e limites”.

O `OpenTelemetryAdapter` cria um span raiz para cada Trajectory e spans para Tracks. Inclui IDs OpenTrajectory, `correlationId`, atributos, timestamps, duração, status e exceções. Expansions são exportadas como span events quando `addEvent` está disponível; caso contrário, são representadas por atributos.

Para propagar parent context real entre o span raiz, Tracks e sub-Tracks sem adicionar dependência obrigatória, o construtor aceita um `OpenTelemetryContextBridgeLike` opcional. O bridge adapta `context.active()` e `trace.setSpan(context, span)` do pacote `@opentelemetry/api`:

```ts
import { context, trace } from "@opentelemetry/api";
import { OpenTelemetryAdapter, TrajectoryRuntime } from "@opentrajectory/digital";

const adapter = new OpenTelemetryAdapter(trace.getTracer("service"), {
  active: () => context.active(),
  setSpan: (active, span) => trace.setSpan(active, span as never)
});
const runtime = new TrajectoryRuntime({ exporters: [adapter] });
```

Sem o bridge, o adapter ainda cria spans raiz/Track e preserva `parent_track_id` como atributo, mas não consegue construir parent contexts OTel explícitos para a hierarquia.

Relações causais são exportadas como span links quando o span de destino aceita `addLink` ou quando o link está disponível antes da criação do span (opção `links`). Quando o tracer não oferece esse suporte, a relação permanece preservada em atributos no span de destino. O adapter guarda SpanContexts de origem até o fim da Trajectory para permitir relações registradas depois que o span de origem terminou.

O encerramento dos spans usa `finally`: falhas ao definir status ou registrar exceções não impedem a tentativa de `end()` nem a limpeza dos mapas internos. O core continua utilizável sem instalar OpenTelemetry; apenas o consumidor que usa um tracer real precisa instalar e fornecer `@opentelemetry/api`.

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
| `TrajectoryOptions` | Opções de nome, correlation ID e atributos. |
| `RuntimeOptions` | Opções do runtime: exporters, relógio injetável e limites opcionais. |
| `TrajectoryClock` | Interface de relógio com tempo monotônico e timestamp ISO-8601 injetáveis. |
| `TrajectoryLimits` | Limites opcionais de bytes por mapa de atributos, Expansions por Track e profundidade. |
| `TrajectoryLimitError` | Erro tipado lançado quando um limite configurado é excedido. |
| `TrajectoryLimitCode` | Códigos de overflow de limites. |
| `TrajectoryStreamHub` | Buffer de eventos, snapshots, replay, subscriptions e backpressure. |
| `TrajectoryStreamExporter` | Exporter que converte hooks do runtime em eventos versionados. |
| `TrajectoryStreamSubscription` | Leitor assíncrono de frames com fila limitada e ressincronização. |
| `TrajectoryStreamStore` | Reducer de snapshots, replay e eventos incrementais para clientes TUI/Web. |
| `TrajectoryWebSocketServer` | Transporte WebSocket com binding local padrão e autorização obrigatória fora do loopback. |
| `projectTrajectorySnapshot(snapshot)` | Projeção compartilhada de árvore, sequência temporal, ordem causal e relações. |
| `TrajectoryStreamEventType` | União dos eventos versionados de Trajectory, Track, Expansion, Relation e falha. |
| `TrajectoryStreamEvent` | Envelope de evento com sessão, sequência, timestamp, tipo e payload. |
| `TrajectoryStreamFrame` | União de frame de snapshot, replay ou evento incremental. |
| `TrajectoryStreamSnapshotFrame` | Snapshot de ressincronização com motivo e sequência atual. |
| `TrajectoryStreamReplayFrame` | Batch de eventos após um cursor válido. |
| `TrajectoryStreamEventFrame` | Frame que contém um evento incremental. |
| `TrajectoryStreamConnection` | Frame inicial e subscription para o consumidor. |
| `TrajectoryStreamHubOptions` | Configuração de sessão, buffer de replay, fila e retenção de snapshots. |
| `TrajectoryTrackNode` | Nó da árvore hierárquica de Tracks. |
| `TrajectoryProjection` | Projeção comum de árvore, sequência temporal, ordem causal e relações. |
| `WebSocketServerFactory` | Adapter estrutural para uma implementação WebSocket fornecida pelo consumidor. |
| `WebSocketServerLike` / `WebSocketConnectionLike` | Contratos estruturais mínimos de servidor e socket. |
| `TrajectoryWebSocketServerOptions` | Host, porta, tamanho máximo de mensagem e autorização. |

## Lifecycle

1. O runtime cria a Trajectory com estado `running` e emite `onTrajectoryStarted`.
2. Cada chamada de `track` cria um Track com sequência crescente e profundidade derivada do Track ativo; emite `onTrackStarted`.
3. `Expand` adiciona um marco ao Track ativo e emite `onExpansion`.
4. Ao concluir, o Track recebe `ok` ou `error`, timestamps e duração; emite `onTrackEnded`.
5. Ao concluir a callback principal, a Trajectory recebe `ok` ou `error`, timestamps e duração; emite `onTrajectoryEnded`.

Erros de callback são propagados ao chamador. Cada hook de exporter é executado mesmo se outro exporter falhar; erros de hooks são agregados em `AggregateError`. A execução é finalizada antes de o erro de exportação ser propagado. Se o callback e a finalização falharem, ambos os erros são preservados no AggregateError. Falhas em hooks de início também acionam os hooks de fim correspondentes para exporters que já tenham aberto recursos.

O Track registra nome e mensagem do erro. `startedAt`, `endedAt` e `Expansion.timestamp` são ISO-8601; durações e offsets são milissegundos monotônicos arredondados. `processUptimeMs` é o tempo monotônico desde o time origin do processo Node.js até o início da Trajectory. `processStartupMs` é um alias legado depreciado com o mesmo valor; não mede a duração de inicialização do processo.

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

## Snapshots, exporters e limites

`snapshot()` cria cópias defensivas de Tracks, atributos, Expansions, erros e relações. Cada exporter recebe sua própria cópia nos hooks; alterar um snapshot ou payload recebido não altera o estado interno nem o que outro exporter recebe. `Attributes` aceita apenas valores primitivos (`string`, `number`, `boolean` ou `null`), portanto a cópia dos mapas é suficiente.

Todos os exporters são chamados para cada hook, mesmo quando um deles lança uma exceção. As exceções são agregadas em `AggregateError` depois que o runtime tenta executar os hooks de finalização. Se a callback e um hook de finalização falharem, ambos os erros são preservados. Hooks são síncronos; exporters não devem iniciar trabalho assíncrono sem gerenciar sua própria conclusão.

A opção `autoReport` foi removida de `TrajectoryOptions` e `RuntimeOptions`: existia no tipo, mas não tinha comportamento implementado. O relatório continua sendo responsabilidade explícita dos exporters, como `ConsoleTrajectoryExporter`.

`RuntimeOptions.clock` permite injetar `TrajectoryClock` para testes determinísticos. `monotonicNow()` mede durações/offsets; `wallTime()` gera timestamps ISO-8601. O relógio padrão usa `performance.now()` e `Date`.

Os limites são opcionais e, por padrão, não impõem restrições adicionais (compatibilidade retroativa):
- `maxAttributeBytes`: máximo de bytes UTF-8 de cada mapa de atributos individual, incluindo atributos da Trajectory, Track, Expansion e Relation.
- `maxExpansionsPerTrack`: máximo de Expansions por Track.
- `maxTrackDepth`: profundidade máxima; Tracks raiz têm profundidade zero.

Os limites são verificados antes da mutação correspondente. Overflow lança `TrajectoryLimitError` com `code`, `limit` e `actual`; o runtime não trunca nem descarta dados silenciosamente. Valores de configuração precisam ser inteiros não negativos.

## Concorrência e isolamento

O contexto ativo é propagado por `AsyncLocalStorage`, portanto chamadas assíncronas e Trajectories concorrentes mantêm seus próprios contextos. A lista de Tracks e relações é acumulada na instância da Trajectory.
## Compatibilidade e depreciação

Não há renomeação nem depreciação de `Expansion` ou `Expand`: são conceitos diferentes e complementares. Símbolos exportados são considerados API pública. Mudanças incompatíveis devem ser anunciadas em release notes e acompanhadas por período de depreciação quando tecnicamente viável.

## Roadmap — não disponível nesta versão

`Destination`, `Journey` e `Step` são termos reservados para possíveis modelos ou aliases futuros. Não são exportados e não possuem contrato implementado.


## Streaming realtime

A API de streaming é documentada em [STREAMING.md](STREAMING.md). O protocolo usa `protocol: "open-trajectory"`, `version: 1`, `sessionId` e sequência monotônica por sessão. Conexões novas recebem snapshot; clientes que reconectam podem receber replay desde o último cursor ou snapshot de ressincronização. As filas de subscribers são limitadas; backpressure descarta eventos pendentes do cliente lento e entrega snapshot atualizado na próxima leitura.

O servidor WebSocket não inclui implementação de socket no core. O consumidor injeta uma `WebSocketServerFactory` (por exemplo, adaptada ao pacote `ws`). O binding padrão é `127.0.0.1:7331`; host não local exige callback `authorize`. TUI e dashboard Web devem aplicar `TrajectoryStreamStore` e `projectTrajectorySnapshot` para compartilhar a mesma semântica visual.
