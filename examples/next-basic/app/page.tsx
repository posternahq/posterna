import { headers } from "next/headers";

export default async function Home() {
  const request = await headers();
  return (
    <main>
      <h1>Hello</h1>
      <p>
        Posterna labeled this request <code>{request.get("x-agent-verdict")}</code>.
      </p>
    </main>
  );
}
