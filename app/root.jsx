import { useEffect, useState } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigation,
} from "react-router";

function AppLoadingProgress() {
  const navigation = useNavigation();
  const [visible, setVisible] = useState(true);
  const [progress, setProgress] = useState(8);
  const isNavigating = navigation.state !== "idle";

  useEffect(() => {
    if (isNavigating) {
      setVisible(true);
      setProgress(12);
      return undefined;
    }

    setProgress(100);
    const hideTimer = window.setTimeout(() => setVisible(false), 450);
    return () => window.clearTimeout(hideTimer);
  }, [isNavigating]);

  useEffect(() => {
    if (!visible || progress >= 95 || !isNavigating) return undefined;

    const interval = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 95) return current;
        const remaining = 95 - current;
        return Math.min(95, current + Math.max(1, Math.round(remaining * 0.08)));
      });
    }, 280);

    return () => window.clearInterval(interval);
  }, [isNavigating, progress, visible]);

  if (!visible) return null;

  return (
    <div
      aria-live="polite"
      aria-label={`Loading ${progress}%`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "grid",
        placeItems: "center",
        background: "rgba(248, 250, 252, 0.92)",
        backdropFilter: "blur(4px)",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <div
        style={{
          width: "min(420px, calc(100vw - 40px))",
          border: "1px solid #dbe3ef",
          borderRadius: "16px",
          background: "#ffffff",
          boxShadow: "0 18px 48px rgba(15, 23, 42, 0.14)",
          padding: "18px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "16px",
            marginBottom: "12px",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "14px",
                fontWeight: 800,
                color: "#0f172a",
              }}
            >
              Loading Backorder Ops
            </div>
            <div
              style={{
                marginTop: "4px",
                fontSize: "12px",
                color: "#667085",
                fontWeight: 500,
              }}
            >
              Syncing inventory and order data
            </div>
          </div>
          <div
            style={{
              fontSize: "20px",
              fontWeight: 800,
              color: "#1d4ed8",
              minWidth: "54px",
              textAlign: "right",
            }}
          >
            {progress}%
          </div>
        </div>
        <div
          style={{
            height: "10px",
            borderRadius: "999px",
            overflow: "hidden",
            background: "#e7edf5",
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: "100%",
              borderRadius: "999px",
              background: "linear-gradient(90deg, #2563eb 0%, #16a34a 100%)",
              transition: "width 220ms ease",
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <AppLoadingProgress />
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
