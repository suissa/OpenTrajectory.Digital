# OpenTrajectory.Digital

SDK TypeScript para instrumentar execuções como uma estrutura temporal e causal. Uma **Trajectory** agrupa **Tracks** hierárquicos; cada Track pode registrar **Expansions** (marcos) e relações causais.

| Conceito | Contrato no SDK |
| --- | --- |
| Trajectory | Execução observada, com correlation ID opcional |
| Track | Unidade de trabalho dentro de uma Trajectory |
| Expansion | Registro de um marco ocorrido dentro de um Track |
| Expand | Função que registra uma Expansion no Track ativo |
| Relation | Relação causal ou de dependência entre Tracks |

**Expansion** é o dado registrado. **Expand** é a operação que cria esse registro. Os nomes são intencionalmente distintos; nenhum deles é alias do outro.

## Instalação e validação

```bash
npm install @opentrajectory/digital
```

Para validar o repositório:

```bash
npm install
npm run check
npm run build
npm test
npm run example
# ou tudo de uma vez:
npm run ci
```

O SDK requer Node.js 20 ou superior. Os exemplos e snippets abaixo usam imports do pacote publicado.

## Instrumentação com decorators

Configure `experimentalDecorators: true` no `tsconfig.json` para o modo legacy do TypeScript. `@Track` também reconhece o formato de decorators Stage 3.

```ts
import { Expand, Track, Trajectory } from "@opentrajectory/digital";

@Trajectory({ name: "customer-support.request" })
class CustomerSupportFlow {
  @Track({ name: "intake.message" })
  async intake(message: string): Promise<void> {
    Expand("message.received", { characters: message.length });
    await this.classify(message);
  }

  @Track("classify.intent")
  async classify(message: string): Promise<void> {
    Expand("intent.resolved", { intent: "billing.question" });
    void message;
  }
}

await new CustomerSupportFlow().intake("Onde está meu comprovante?");
```

Quando um método decorado é chamado sem contexto ativo, o SDK cria uma Trajectory automaticamente. Dentro de uma Trajectory existente, ele cria um Track filho. Métodos síncronos continuam síncronos; métodos que retornam Promise continuam assíncronos.

## Execução explícita, exporters e correlation ID

```ts
import {
  ConsoleTrajectoryExporter,
  TrajectoryRuntime
} from "@opentrajectory/digital";

const runtime = new TrajectoryRuntime({
  exporters: [new ConsoleTrajectoryExporter()]
});

await runtime.trajectory(
  {
    name: "support.debug",
    correlationId: "request-42",
    attributes: { channel: "whatsapp" }
  },
  () => runtime.current()!.track("handle.message", () => {
    // código instrumentado
  })
);
```

O runtime propaga o contexto através de operações assíncronas usando `AsyncLocalStorage`. Trajectories concorrentes mantêm contextos isolados. Consulte [a referência da API](docs/API.md) para os contratos completos, lifecycle e limitações.

## OpenTelemetry

O adaptador aceita um tracer estruturalmente compatível; não adiciona dependência obrigatória de OpenTelemetry ao core.

```ts
import { trace } from "@opentelemetry/api";
import {
  OpenTelemetryAdapter,
  TrajectoryRuntime
} from "@opentrajectory/digital";

const runtime = new TrajectoryRuntime({
  exporters: [new OpenTelemetryAdapter(trace.getTracer("my-service"))]
});
```

## Escopo atual e roadmap

Implementado: Trajectory, Track, Expansion/Expand, relações entre Tracks, decorators, exporters de console e OpenTelemetry e snapshots.

Reservado para versões futuras: **Destination**, **Journey** e **Step**. Esses nomes não são classes, tipos ou APIs exportadas nesta versão. Não devem ser usados como se já fossem implementados.

O SDK não persiste snapshots nem payloads de negócio. A integração com armazenamento é responsabilidade de exporters ou de componentes externos.
