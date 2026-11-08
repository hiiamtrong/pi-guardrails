import { appendFileSync } from "node:fs";

export default function (pi: { on: (event: string, handler: (event: any) => unknown) => void }) {
  pi.on("before_provider_request", (event) => {
    const path = process.env.SECRET_GUARD_PAYLOAD_TAP;
    if (path) appendFileSync(path, `${JSON.stringify(event.payload)}\n`);
    return undefined;
  });
}
