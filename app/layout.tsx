import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RecoverOS — Revenue recovery intelligence",
  description: "Policy-bounded recovery decisions for failed recurring payments.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
