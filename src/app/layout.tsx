import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { ThemeProviderScript } from "@/components/ui/theme-toggle";
import "./globals.css";

const sans = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F8F9FA" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

export const metadata: Metadata = {
  title: {
    default: "Offline",
    template: "%s · Offline",
  },
  description: "Offline — live customer assistance, focused.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Offline",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <ThemeProviderScript />
      </head>
      <body className="min-h-full bg-background text-foreground">
        {children}
        <Toaster richColors position="top-right" theme="system" closeButton />
      </body>
    </html>
  );
}
