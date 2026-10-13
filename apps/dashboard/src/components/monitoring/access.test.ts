import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const auth = vi.hoisted(() => ({ user: null as { role: string } | null, isLoading: false }));
const monitoringHooks = vi.hoisted(() => ({
  useServerMetrics: vi.fn(), useContainerMetrics: vi.fn(),
  useMetricHistory: vi.fn(), useThresholdAlerts: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => auth }));
vi.mock("@/hooks/useMonitoring", () => monitoringHooks);
vi.mock("@/hooks/useDashboardSummary", () => ({ useDashboardSummary: () => ({
  stats: null, serverMetrics: null, activity: [], sslExpiringCount: 0,
  isLoading: false, isError: false, refetch: vi.fn(),
}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
const { MonitoringPage } = await import("./MonitoringPage");
const { Sidebar } = await import("../layout/Sidebar");
const { DashboardOverview } = await import("../dashboard/DashboardOverview");

beforeEach(() => { vi.clearAllMocks(); auth.user = null; auth.isLoading = false; });

describe("monitoring UI access", () => {
  it.each(["USER", "RESELLER", null])("blocks direct page access and never mounts metrics hooks for %s", (role) => {
    auth.user = role ? { role } : null;
    const markup = renderToStaticMarkup(createElement(MonitoringPage));
    expect(markup).toContain("Access restricted");
    for (const hook of Object.values(monitoringHooks)) expect(hook).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(createElement(Sidebar))).not.toContain('href="/monitoring"');
  });

  it("waits for authentication before mounting the monitoring page", () => {
    auth.isLoading = true;
    expect(renderToStaticMarkup(createElement(MonitoringPage))).toBe("");
    for (const hook of Object.values(monitoringHooks)) expect(hook).not.toHaveBeenCalled();
  });

  it("shows Monitoring navigation to administrators", () => {
    auth.user = { role: "ADMIN" };
    expect(renderToStaticMarkup(createElement(Sidebar))).toContain('href="/monitoring"');
  });

  it.each(["USER", "RESELLER", "ADMIN"])("restricts the dashboard Server Health widget for %s", (role) => {
    auth.user = { role };
    const markup = renderToStaticMarkup(createElement(DashboardOverview));
    expect(markup.includes("Server Health")).toBe(role === "ADMIN");
    expect(markup).toContain("Total Projects");
    expect(markup).toContain("Recent Activity");
  });
});
