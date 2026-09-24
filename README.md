# OpenTrajectory.Digital

Biblioteca TypeScript para depurar execução como uma estrutura temporal e causal — usando um vocabulário semântico que pode ser repetido em outras linguagens.

| OpenTelemetry | OpenTrajectory |
| --- | --- |
| Trace | **Trajectory** |
| Span | **Track** |
| Event | **Expansion** |
| Trace ID | `trajectory.id` |
| Correlation ID | `correlationId` |

Uma **Trajectory** contém **Tracks** hierárquicos. Cada Track registra **Expansions** (marcos que explicam o que foi acontecendo) e relações causais prontas para Causal-Topological: `causes`, `depends_on`, `expands`, `follows`, `derives_from`.

## Rodar agora

~~~bash
npm install
npm run example
~~~

A saída mostra cada início, expansão, término e um relatório final, sem banco:

~~~text
◉ TRAJECTORY support.debug.session [...] correlation=wa-...-msg-42
▶ intake.message
  ↳ message.received +0ms
  ▶ classify.intent
    ↳ model.prompt.composed +0ms
    ↳ intent.resolved +1ms
  ✓ classify.intent 1ms
✓ intake.message 2ms
■ REPORT support.debug.session: ok, 2 tracks, 0 causal links, 2ms
~~~

## Decorators

Ative `experimentalDecorators` no `tsconfig.json`.

~~~ts
import { Trajectory, Track, Expand } from "@opentrajectory/digital";

@Trajectory({ name: "customer-support.request" })
class CustomerSupportFlow {
  @Track({ name: "intake.message" })
  async intake(message: string) {
    Expand("message.received", { characters: message.length });
    await this.classify(message);
  }

  @Track("classify.intent")
  async classify(message: string) {
    Expand("intent.resolved", { intent: "billing.question", confidence: 0.92 });
  }
}
~~~

Se um método decorado é chamado sem uma Trajectory ativa, ele inicia uma automaticamente. Se já houver uma, o método vira um Track filho; a árvore acompanha o caminho real da execução assíncrona.

## Trajectory explícita e correlation ID

~~~ts
const runtime = new TrajectoryRuntime({
  exporters: [new ConsoleTrajectoryExporter()]
});

await runtime.trajectory(
  { name: "support.debug", correlationId: incomingMessage.id },
  () => service.handle(incomingMessage)
);
~~~

## Adapter OpenTelemetry / Grafana

O adaptador usa interfaces estruturais: não obriga instalar OpenTelemetry, mas aceita o mesmo `Tracer` que seu projeto já fornece para OTLP Collector, Grafana ou Tempo.

~~~ts
import { trace } from "@opentelemetry/api";
import { OpenTelemetryAdapter, TrajectoryRuntime } from "@opentrajectory/digital";

const runtime = new TrajectoryRuntime({
  exporters: [new OpenTelemetryAdapter(trace.getTracer("my-service"))]
});
~~~

Cada Track gera um span OTel com IDs, pai, profundidade, sequência, duração e Expansions como atributos. O Console exporter continua ideal para rodar local e enxergar o passo a passo.

## Contrato policromático

A primeira implementação é TypeScript. Estes nomes serão o contrato semântico dos SDKs futuros:

- **Trajectory**: macroexecução espacial/temporal.
- **Track**: unidade micro de execução; equivale a span.
- **Expansion**: fato incremental dentro do Track.
- **Destination**: resultado/objetivo futuro (reservado).
- **Journey** e **Step**: aliases de fluxo previstos para SDKs que prefiram o vocabulário de jornada.

O core não armazena payloads: somente nomes e atributos escolhidos por você. Persistência e projeções para o banco causal-topológico serão exporters adicionais, sem alterar decorators, API ou estrutura do evento.
