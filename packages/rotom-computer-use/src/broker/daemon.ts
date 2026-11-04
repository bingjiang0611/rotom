/**
 * Broker daemon entry point.
 *
 * Spawned detached by `client.ts` when no broker is listening. Exits quietly
 * when another broker already owns the socket, so racing spawners converge on
 * one process.
 */
import { startBrokerServer, BrokerAlreadyRunningError } from "./server.ts";

const socketPath = process.env.ROTOM_CU_BROKER_SOCKET;

async function main(): Promise<void> {
	const server = await startBrokerServer(socketPath ? { socketPath } : {});
	const shutdown = () => {
		void server.close().then(() => process.exit(0));
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	await server.closed;
	process.exit(0);
}

main().catch((error: unknown) => {
	if (error instanceof BrokerAlreadyRunningError) process.exit(0);
	process.stderr.write(`broker daemon failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
