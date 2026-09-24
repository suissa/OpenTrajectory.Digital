import { ConsoleTrajectoryExporter, Expand, Track, Trajectory, TrajectoryRuntime } from "../src/index.js";
const runtime = new TrajectoryRuntime({ exporters: [new ConsoleTrajectoryExporter()] });
@Trajectory({ name: "customer-support.request" })
class CustomerSupportFlow {
  @Track({ name: "intake.message" })
  async intake(message: string): Promise<void> { Expand("message.received", { characters: message.length }); await this.classify(message); }
  @Track("classify.intent")
  async classify(message: string): Promise<void> { Expand("model.prompt.composed", { model: "local" }); await Promise.resolve(); Expand("intent.resolved", { intent: "billing.question", confidence: 0.92 }); void message; }
}
await runtime.trajectory({ name: "support.debug.session", correlationId: "wa-5515990000000-msg-42", attributes: { channel: "whatsapp" } }, () => new CustomerSupportFlow().intake("Onde está o meu comprovante?"));