import * as Clipboard from "expo-clipboard";
import {
  Activity,
  CircleOff,
  Copy,
  FileText,
  Gauge,
  LoaderCircle,
  Power,
  Radio,
  ShieldCheck,
  Smartphone,
  Square,
} from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  type AppStateStatus,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

import type {
  MobileAgentControllerSnapshot,
  MobileAgentViewState,
} from "./mobile-agent-controller";
import { createMobileAgentController } from "./mobile-platform";
import { mobilePublicConfiguration } from "./mobile-public-configuration";

type ViewName = "overview" | "logs";

interface StatusEvent {
  readonly id: number;
  readonly occurredAt: string;
  readonly state: MobileAgentViewState;
  readonly errorCode: string | null;
}

const INITIAL_SNAPSHOT: MobileAgentControllerSnapshot = Object.freeze({
  state: "loading",
  registration: null,
  activeStreams: 0,
  connectedAt: null,
  errorCode: null,
});

const STATUS_COLORS = {
  border: "#d8dde5",
  danger: "#c53d43",
  ink: "#18202a",
  muted: "#66717f",
  panel: "#ffffff",
  surface: "#f4f6f8",
  teal: "#087f73",
  warning: "#a15c00",
} as const;

export default function App() {
  const [view, setView] = useState<ViewName>("overview");
  const { width } = useWindowDimensions();
  const wide = width >= 720;

  if (Platform.OS !== "android" && Platform.OS !== "ios") {
    return <DesktopRendererPlaceholder view={view} setView={setView} wide={wide} />;
  }

  return <MobileAgentApp view={view} setView={setView} wide={wide} />;
}

function MobileAgentApp({
  view,
  setView,
  wide,
}: {
  readonly view: ViewName;
  readonly setView: (view: ViewName) => void;
  readonly wide: boolean;
}) {
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT);
  const [activationCode, setActivationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [events, setEvents] = useState<readonly StatusEvent[]>([]);
  const eventId = useRef(0);
  const configuration = useMemo(mobilePublicConfiguration, []);
  const controller = useMemo(() => {
    if (!configuration) {
      return null;
    }
    return createMobileAgentController(configuration, (next) => {
      setSnapshot(next);
      setEvents((current) =>
        [
          {
            id: ++eventId.current,
            occurredAt: new Date().toISOString(),
            state: next.state,
            errorCode: next.errorCode,
          },
          ...current,
        ].slice(0, 100),
      );
    });
  }, [configuration]);

  useEffect(() => {
    if (!controller) {
      setSnapshot({
        ...INITIAL_SNAPSHOT,
        state: "unavailable",
        errorCode: "CONFIGURATION_REQUIRED",
      });
      return;
    }
    void controller.initialize();
    const subscription = AppState.addEventListener("change", (state) => {
      void controller.handleAppState(foregroundState(state));
    });
    return () => {
      subscription.remove();
      void controller.dispose();
    };
  }, [controller]);

  const activate = async () => {
    if (!controller || busy || snapshot.state !== "unregistered") {
      return;
    }
    setBusy(true);
    try {
      await controller.activate(activationCode);
      setActivationCode("");
    } catch {
      // The controller publishes a stable, sanitized error code.
    } finally {
      setBusy(false);
    }
  };

  const toggleRuntime = async () => {
    if (!controller || busy) {
      return;
    }
    setBusy(true);
    try {
      if (snapshot.state === "stopped") {
        await controller.start();
      } else {
        await controller.stop();
      }
    } catch {
      // Runtime state is published through the controller callback.
    } finally {
      setBusy(false);
    }
  };

  const copyProxyId = async () => {
    const proxyId = snapshot.registration?.proxyId;
    if (!proxyId) {
      return;
    }
    await Clipboard.setStringAsync(proxyId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <AppShell view={view} setView={setView} state={snapshot.state}>
      {view === "logs" ? (
        <EventLog events={events} />
      ) : snapshot.registration ? (
        <RegisteredOverview
          busy={busy}
          copied={copied}
          onCopy={() => void copyProxyId()}
          onToggle={() => void toggleRuntime()}
          snapshot={snapshot}
          wide={wide}
        />
      ) : (
        <ActivationPanel
          activationCode={activationCode}
          busy={busy}
          errorCode={snapshot.errorCode}
          onActivate={() => void activate()}
          onChange={setActivationCode}
          ready={snapshot.state === "unregistered"}
        />
      )}
    </AppShell>
  );
}

function AppShell({
  view,
  setView,
  state,
  children,
}: {
  readonly view: ViewName;
  readonly setView: (view: ViewName) => void;
  readonly state: MobileAgentViewState;
  readonly children: React.ReactNode;
}) {
  const status = statusPresentation(state);
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor={STATUS_COLORS.surface} />
      <View style={styles.shell}>
        <View style={styles.header}>
          <View>
            <Text style={styles.productName}>MHub Agent</Text>
            <Text style={styles.version}>v0.1.0</Text>
          </View>
          <View style={styles.headerState}>
            <View style={[styles.stateDot, { backgroundColor: status.color }]} />
            <Text style={[styles.headerStateText, { color: status.color }]}>{status.label}</Text>
          </View>
        </View>
        <View accessibilityRole="tablist" style={styles.tabs}>
          <Tab active={view === "overview"} label="总览" onPress={() => setView("overview")} />
          <Tab active={view === "logs"} label="事件" onPress={() => setView("logs")} />
        </View>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.content}>{children}</View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function ActivationPanel({
  activationCode,
  busy,
  errorCode,
  onActivate,
  onChange,
  ready,
}: {
  readonly activationCode: string;
  readonly busy: boolean;
  readonly errorCode: string | null;
  readonly onActivate: () => void;
  readonly onChange: (value: string) => void;
  readonly ready: boolean;
}) {
  const disabled = !ready || busy || activationCode.trim().length === 0;
  return (
    <View style={styles.activationLayout}>
      <View style={styles.activationHeader}>
        <View style={styles.activationIcon}>
          <ShieldCheck color={STATUS_COLORS.teal} size={28} />
        </View>
        <Text style={styles.activationTitle}>激活此设备</Text>
        <Text style={styles.activationDetail}>输入控制台生成的一次性激活码</Text>
      </View>
      <Text style={styles.inputLabel}>激活码</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        editable={ready && !busy}
        maxLength={160}
        onChangeText={onChange}
        onSubmitEditing={onActivate}
        placeholder="请输入激活码"
        placeholderTextColor={STATUS_COLORS.muted}
        secureTextEntry
        style={styles.input}
        value={activationCode}
      />
      {errorCode ? <Text style={styles.errorText}>{friendlyError(errorCode)}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled, busy }}
        disabled={disabled}
        onPress={onActivate}
        style={({ pressed }) => [
          styles.activationButton,
          disabled && styles.buttonDisabled,
          pressed && !disabled && styles.buttonPressed,
        ]}
      >
        {busy ? (
          <LoaderCircle color="#ffffff" size={19} />
        ) : (
          <ShieldCheck color="#ffffff" size={19} />
        )}
        <Text style={styles.primaryButtonText}>激活</Text>
      </Pressable>
    </View>
  );
}

function RegisteredOverview({
  busy,
  copied,
  onCopy,
  onToggle,
  snapshot,
  wide,
}: {
  readonly busy: boolean;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onToggle: () => void;
  readonly snapshot: MobileAgentControllerSnapshot;
  readonly wide: boolean;
}) {
  const status = statusPresentation(snapshot.state);
  const running = snapshot.state !== "stopped" && snapshot.state !== "unavailable";
  return (
    <View style={styles.section}>
      <View style={styles.statusBand}>
        <View style={styles.statusCopy}>
          <Text style={styles.eyebrow}>代理状态</Text>
          <Text style={styles.statusTitle}>{status.title}</Text>
          <Text style={styles.statusDetail}>{status.detail}</Text>
        </View>
        <View style={[styles.statusIcon, snapshot.state === "online" && styles.statusIconOnline]}>
          {snapshot.state === "connecting" || snapshot.state === "backoff" ? (
            <LoaderCircle color={status.color} size={28} />
          ) : (
            <Radio color={status.color} size={28} strokeWidth={1.8} />
          )}
        </View>
      </View>

      <Text style={styles.sectionTitle}>连接信息</Text>
      <View style={styles.metrics}>
        <Metric
          icon={<Activity color={STATUS_COLORS.teal} size={20} />}
          label="代理 ID"
          value={snapshot.registration?.proxyId ?? "--"}
          wide={wide}
        />
        <Metric
          icon={<Gauge color={STATUS_COLORS.teal} size={20} />}
          label="活动连接"
          value={`${snapshot.activeStreams}`}
          wide={wide}
        />
      </View>

      {snapshot.errorCode ? (
        <Text style={styles.errorText}>{friendlyError(snapshot.errorCode)}</Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable accessibilityLabel="复制代理 ID" onPress={onCopy} style={styles.iconButton}>
          <Copy color={STATUS_COLORS.ink} size={20} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={onToggle}
          style={({ pressed }) => [
            styles.primaryButton,
            running && styles.stopButton,
            busy && styles.buttonDisabled,
            pressed && !busy && styles.buttonPressed,
          ]}
        >
          {running ? (
            <Square color="#ffffff" fill="#ffffff" size={16} />
          ) : (
            <Power color="#ffffff" size={19} />
          )}
          <Text style={styles.primaryButtonText}>{running ? "停止代理" : "启动代理"}</Text>
        </Pressable>
      </View>
      {copied ? <Text style={styles.copiedText}>代理 ID 已复制</Text> : null}

      <View style={styles.notice}>
        <Smartphone color={STATUS_COLORS.warning} size={18} />
        <Text style={styles.noticeText}>移动端仅在 App 前台时在线</Text>
      </View>
    </View>
  );
}

function EventLog({ events }: { readonly events: readonly StatusEvent[] }) {
  if (events.length === 0) {
    return (
      <View style={styles.emptyState}>
        <FileText color={STATUS_COLORS.muted} size={30} strokeWidth={1.7} />
        <Text style={styles.emptyTitle}>暂无事件</Text>
      </View>
    );
  }
  return (
    <View style={styles.eventList}>
      {events.map((event) => {
        const status = statusPresentation(event.state);
        return (
          <View key={event.id} style={styles.eventRow}>
            <View style={[styles.eventMarker, { backgroundColor: status.color }]} />
            <View style={styles.eventCopy}>
              <Text style={styles.eventTitle}>{status.label}</Text>
              <Text style={styles.eventDetail}>
                {event.errorCode ? friendlyError(event.errorCode) : "状态已更新"}
              </Text>
            </View>
            <Text style={styles.eventTime}>{formatTime(event.occurredAt)}</Text>
          </View>
        );
      })}
    </View>
  );
}

function DesktopRendererPlaceholder({
  view,
  setView,
}: {
  readonly view: ViewName;
  readonly setView: (view: ViewName) => void;
  readonly wide: boolean;
}) {
  return (
    <AppShell view={view} setView={setView} state="unregistered">
      <View style={styles.emptyState}>
        <CircleOff color={STATUS_COLORS.muted} size={30} />
        <Text style={styles.emptyTitle}>桌面宿主尚未连接</Text>
      </View>
    </AppShell>
  );
}

function Tab({
  active,
  label,
  onPress,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.tab, active && styles.tabActive]}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Metric({
  icon,
  label,
  value,
  wide,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
  readonly wide: boolean;
}) {
  return (
    <View style={[styles.metric, wide && styles.metricWide]}>
      <View style={styles.metricIcon}>{icon}</View>
      <View style={styles.metricCopy}>
        <Text style={styles.metricLabel}>{label}</Text>
        <Text numberOfLines={1} selectable style={styles.metricValue}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function foregroundState(value: AppStateStatus): "active" | "inactive" | "background" | "unknown" {
  return value === "active" || value === "inactive" || value === "background" ? value : "unknown";
}

function statusPresentation(state: MobileAgentViewState) {
  switch (state) {
    case "loading":
      return { label: "载入中", title: "正在载入", detail: "", color: STATUS_COLORS.muted };
    case "unregistered":
      return { label: "未激活", title: "客户端尚未激活", detail: "", color: STATUS_COLORS.danger };
    case "stopped":
      return {
        label: "已停止",
        title: "代理已停止",
        detail: "设备当前不提供网络出口",
        color: STATUS_COLORS.muted,
      };
    case "connecting":
      return {
        label: "连接中",
        title: "正在连接 Relay",
        detail: "正在注册安全会话",
        color: STATUS_COLORS.warning,
      };
    case "online":
      return {
        label: "在线",
        title: "代理在线",
        detail: "设备正在提供网络出口",
        color: STATUS_COLORS.teal,
      };
    case "backoff":
      return {
        label: "重连中",
        title: "等待重新连接",
        detail: "网络恢复后将自动重试",
        color: STATUS_COLORS.warning,
      };
    case "unavailable":
      return {
        label: "不可用",
        title: "客户端不可用",
        detail: "请检查应用配置",
        color: STATUS_COLORS.danger,
      };
  }
}

function friendlyError(code: string): string {
  if (code.startsWith("ACTIVATION_REQUEST_FAILED_")) {
    return "激活失败，请检查激活码";
  }
  if (code.startsWith("SESSION_TICKET_REQUEST_FAILED_")) {
    return "身份验证失败，请稍后重试";
  }
  const messages: Record<string, string> = {
    ACTIVATION_CODE_INVALID: "激活码格式不正确",
    CONFIGURATION_REQUIRED: "客户端服务地址尚未配置",
    CONTROL_CHANNEL_CLOSED: "Relay 连接已断开",
    MOBILE_TUNNEL_STOP_FAILED: "本地数据通道停止失败",
    SECURE_STORAGE_DATA_INVALID: "本机设备凭证已损坏",
    SECURE_STORAGE_READ_FAILED: "无法读取本机安全凭证",
    SECURE_STORAGE_UNAVAILABLE: "系统安全存储不可用",
    SECURE_STORAGE_WRITE_FAILED: "无法保存本机安全凭证",
  };
  return messages[code] ?? "操作失败，请稍后重试";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  actions: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 24,
  },
  activationButton: {
    alignItems: "center",
    alignSelf: "stretch",
    backgroundColor: STATUS_COLORS.teal,
    borderRadius: 6,
    flexDirection: "row",
    height: 46,
    justifyContent: "center",
    marginTop: 18,
  },
  activationDetail: { color: STATUS_COLORS.muted, fontSize: 14, marginTop: 7, textAlign: "center" },
  activationHeader: { alignItems: "center", marginBottom: 26 },
  activationIcon: {
    alignItems: "center",
    backgroundColor: "#e7f4f1",
    borderRadius: 6,
    height: 52,
    justifyContent: "center",
    marginBottom: 14,
    width: 52,
  },
  activationLayout: { alignSelf: "center", maxWidth: 460, paddingVertical: 40, width: "100%" },
  activationTitle: { color: STATUS_COLORS.ink, fontSize: 22, fontWeight: "600" },
  buttonDisabled: { opacity: 0.48 },
  buttonPressed: { opacity: 0.82 },
  content: {
    alignSelf: "center",
    maxWidth: 920,
    paddingHorizontal: 18,
    paddingVertical: 24,
    width: "100%",
  },
  copiedText: { color: STATUS_COLORS.teal, fontSize: 12, marginTop: 8, textAlign: "right" },
  emptyState: { alignItems: "center", justifyContent: "center", minHeight: 320 },
  emptyTitle: { color: STATUS_COLORS.ink, fontSize: 18, fontWeight: "600", marginTop: 14 },
  errorText: { color: STATUS_COLORS.danger, fontSize: 13, marginTop: 12 },
  eventCopy: { flex: 1, minWidth: 0 },
  eventDetail: { color: STATUS_COLORS.muted, fontSize: 12, marginTop: 3 },
  eventList: {
    borderColor: STATUS_COLORS.border,
    borderRadius: 6,
    borderWidth: 1,
    overflow: "hidden",
  },
  eventMarker: { borderRadius: 3, height: 8, marginRight: 12, width: 8 },
  eventRow: {
    alignItems: "center",
    backgroundColor: STATUS_COLORS.panel,
    borderBottomColor: STATUS_COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    minHeight: 68,
    paddingHorizontal: 16,
  },
  eventTime: { color: STATUS_COLORS.muted, fontSize: 11, marginLeft: 10 },
  eventTitle: { color: STATUS_COLORS.ink, fontSize: 14, fontWeight: "600" },
  eyebrow: {
    color: STATUS_COLORS.muted,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  header: {
    alignItems: "center",
    backgroundColor: STATUS_COLORS.panel,
    borderBottomColor: STATUS_COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 68,
    paddingHorizontal: 20,
  },
  headerState: { alignItems: "center", flexDirection: "row" },
  headerStateText: { fontSize: 14, fontWeight: "600", marginLeft: 7 },
  iconButton: {
    alignItems: "center",
    borderColor: STATUS_COLORS.border,
    borderRadius: 6,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    marginRight: 10,
    width: 42,
  },
  input: {
    backgroundColor: STATUS_COLORS.panel,
    borderColor: STATUS_COLORS.border,
    borderRadius: 6,
    borderWidth: 1,
    color: STATUS_COLORS.ink,
    fontSize: 15,
    height: 46,
    paddingHorizontal: 14,
  },
  inputLabel: { color: STATUS_COLORS.ink, fontSize: 13, fontWeight: "600", marginBottom: 8 },
  metric: {
    alignItems: "center",
    backgroundColor: STATUS_COLORS.panel,
    borderColor: STATUS_COLORS.border,
    borderRadius: 6,
    borderWidth: 1,
    flexDirection: "row",
    marginBottom: 10,
    minHeight: 84,
    padding: 16,
    width: "100%",
  },
  metricCopy: { flex: 1, minWidth: 0 },
  metricIcon: {
    alignItems: "center",
    backgroundColor: "#e7f4f1",
    borderRadius: 6,
    height: 40,
    justifyContent: "center",
    marginRight: 14,
    width: 40,
  },
  metricLabel: { color: STATUS_COLORS.muted, fontSize: 12 },
  metricValue: { color: STATUS_COLORS.ink, fontSize: 16, fontWeight: "600", marginTop: 3 },
  metricWide: { width: "49%" },
  metrics: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  notice: {
    alignItems: "center",
    borderLeftColor: STATUS_COLORS.warning,
    borderLeftWidth: 3,
    flexDirection: "row",
    marginTop: 28,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  noticeText: { color: STATUS_COLORS.muted, fontSize: 13, marginLeft: 9 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: STATUS_COLORS.teal,
    borderRadius: 6,
    flexDirection: "row",
    height: 42,
    justifyContent: "center",
    minWidth: 132,
    paddingHorizontal: 18,
  },
  primaryButtonText: { color: "#ffffff", fontSize: 14, fontWeight: "600", marginLeft: 8 },
  productName: { color: STATUS_COLORS.ink, fontSize: 19, fontWeight: "700" },
  safeArea: { backgroundColor: STATUS_COLORS.surface, flex: 1 },
  scrollContent: { flexGrow: 1 },
  section: { width: "100%" },
  sectionTitle: {
    color: STATUS_COLORS.ink,
    fontSize: 15,
    fontWeight: "600",
    marginBottom: 12,
    marginTop: 28,
  },
  shell: { flex: 1 },
  stateDot: { borderRadius: 4, height: 8, width: 8 },
  statusBand: {
    alignItems: "center",
    backgroundColor: STATUS_COLORS.panel,
    borderColor: STATUS_COLORS.border,
    borderRadius: 6,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 132,
    padding: 20,
  },
  statusCopy: { flex: 1, paddingRight: 16 },
  statusDetail: { color: STATUS_COLORS.muted, fontSize: 14, marginTop: 8 },
  statusIcon: {
    alignItems: "center",
    backgroundColor: STATUS_COLORS.surface,
    borderRadius: 6,
    height: 52,
    justifyContent: "center",
    width: 52,
  },
  statusIconOnline: { backgroundColor: "#e7f4f1" },
  statusTitle: { color: STATUS_COLORS.ink, fontSize: 22, fontWeight: "600", marginTop: 7 },
  stopButton: { backgroundColor: STATUS_COLORS.danger },
  tab: {
    alignItems: "center",
    borderBottomColor: "transparent",
    borderBottomWidth: 2,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 18,
  },
  tabActive: { borderBottomColor: STATUS_COLORS.teal },
  tabText: { color: STATUS_COLORS.muted, fontSize: 14, fontWeight: "500" },
  tabTextActive: { color: STATUS_COLORS.ink, fontWeight: "600" },
  tabs: {
    backgroundColor: STATUS_COLORS.panel,
    borderBottomColor: STATUS_COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    paddingHorizontal: 10,
  },
  version: { color: STATUS_COLORS.muted, fontSize: 11, marginTop: 2 },
});
