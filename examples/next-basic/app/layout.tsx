import type { ReactNode } from "react";

export const metadata = { title: "Posterna and Next.js 16" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
