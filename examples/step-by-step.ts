import { ConsoleTrajectoryExporter, Expand, Track, Trajectory, TrajectoryRuntime } from "../src/index.js";
const runtime = new TrajectoryRuntime({ exporters: [new ConsoleTrajectoryExporter()] });
const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

@Trajectory({ name: "customer-support.request" })
class CustomerSupportFlow {
  @Track({ name: "intake.message" })
  async intake(message: string): Promise<void> {
    Expand("message.received", { characters: message.length });
    await this.classify(message);
  }

  @Track("classify.intent")
  async classify(message: string): Promise<void> {
    Expand("model.prompt.composed", { model: "local" });
    await wait(75); // Simulates real async work such as an LLM, HTTP request, database, or queue.
    Expand("intent.resolved", { intent: "billing.question", confidence: 0.92 });
    void message;
  }
}

await runtime.trajectory(
  { name: "support.debug.session", correlationId: "wa-5515990000000-msg-42", attributes: { channel: "whatsapp" } },
  () => new CustomerSupportFlow().intake("Onde está o meu comprovante?")
);