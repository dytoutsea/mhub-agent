import { type AgentPlatform, createInitialAgentSnapshot } from "@mhub/shared";
import { Activity, CircleOff, Copy, FileText, Gauge, Power, Radio } from "lucide-react-native";
import { useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

type ViewName = "overview" | "logs";

const STATUS_COLORS = {
  border: "#d8dde5",
  danger: "#c53d43",
  ink: "#18202a",
  muted: "#66717f",
  panel: "#ffffff",
  surface: "#f4f6f8",
  teal: "#087f73",
} as const;

function currentPlatform(): AgentPlatform {
  switch (Platform.OS) {
    case "android":
      return "android";
    case "ios":
      return "ios";
    case "windows":
      return "windows";
    default:
      return "macos";
  }
}

export default function App() {
  const [view, setView] = useState<ViewName>("overview");
  const { width } = useWindowDimensions();
  const snapshot = useMemo(() => createInitialAgentSnapshot(currentPlatform()), []);
  const wide = width >= 720;

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
            <CircleOff color={STATUS_COLORS.danger} size={18} strokeWidth={2} />
            <Text style={styles.headerStateText}>未激活</Text>
          </View>
        </View>

        <View accessibilityRole="tablist" style={styles.tabs}>
          <Tab active={view === "overview"} label="总览" onPress={() => setView("overview")} />
          <Tab active={view === "logs"} label="日志" onPress={() => setView("logs")} />
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={[styles.content, wide && styles.contentWide]}>
            {view === "overview" ? (
              <Overview activeStreams={snapshot.activeStreams} wide={wide} />
            ) : (
              <EmptyLogs />
            )}
          </View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

interface TabProps {
  readonly active: boolean;
  readonly label: string;
  readonly onPress: () => void;
}

function Tab({ active, label, onPress }: TabProps) {
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

function Overview({
  activeStreams,
  wide,
}: {
  readonly activeStreams: number;
  readonly wide: boolean;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.statusBand}>
        <View style={styles.statusCopy}>
          <Text style={styles.eyebrow}>代理状态</Text>
          <Text style={styles.statusTitle}>客户端尚未注册</Text>
          <Text style={styles.statusDetail}>数据通道未接入</Text>
        </View>
        <View style={styles.statusIcon}>
          <Radio color={STATUS_COLORS.muted} size={28} strokeWidth={1.8} />
        </View>
      </View>

      <Text style={styles.sectionTitle}>连接信息</Text>
      <View style={styles.metrics}>
        <Metric
          icon={<Activity color={STATUS_COLORS.teal} size={20} />}
          label="代理 ID"
          value="--"
          wide={wide}
        />
        <Metric
          icon={<Gauge color={STATUS_COLORS.teal} size={20} />}
          label="活动连接"
          value={`${activeStreams}`}
          wide={wide}
        />
      </View>

      <View style={styles.actions}>
        <Pressable accessibilityLabel="复制代理 ID" disabled style={styles.iconButton}>
          <Copy color={STATUS_COLORS.muted} size={20} />
        </Pressable>
        <Pressable accessibilityState={{ disabled: true }} disabled style={styles.primaryButton}>
          <Power color="#ffffff" size={19} />
          <Text style={styles.primaryButtonText}>启动代理</Text>
        </Pressable>
      </View>

      <View style={styles.notice}>
        <Text style={styles.noticeText}>当前版本仅包含客户端工程骨架</Text>
      </View>
    </View>
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
      <View>
        <Text style={styles.metricLabel}>{label}</Text>
        <Text style={styles.metricValue}>{value}</Text>
      </View>
    </View>
  );
}

function EmptyLogs() {
  return (
    <View style={styles.emptyState}>
      <FileText color={STATUS_COLORS.muted} size={30} strokeWidth={1.7} />
      <Text style={styles.emptyTitle}>暂无日志</Text>
      <Text style={styles.emptyDetail}>代理运行后，脱敏事件将显示在这里</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 24,
  },
  content: {
    alignSelf: "center",
    maxWidth: 920,
    paddingHorizontal: 18,
    paddingVertical: 24,
    width: "100%",
  },
  contentWide: {
    paddingHorizontal: 32,
    paddingVertical: 32,
  },
  emptyDetail: {
    color: STATUS_COLORS.muted,
    fontSize: 14,
    marginTop: 6,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 320,
  },
  emptyTitle: {
    color: STATUS_COLORS.ink,
    fontSize: 18,
    fontWeight: "600",
    marginTop: 14,
  },
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
  headerState: {
    alignItems: "center",
    flexDirection: "row",
  },
  headerStateText: {
    color: STATUS_COLORS.danger,
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 7,
  },
  iconButton: {
    alignItems: "center",
    borderColor: STATUS_COLORS.border,
    borderRadius: 6,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    marginRight: 10,
    opacity: 0.55,
    width: 42,
  },
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
  metricIcon: {
    alignItems: "center",
    backgroundColor: "#e7f4f1",
    borderRadius: 6,
    height: 40,
    justifyContent: "center",
    marginRight: 14,
    width: 40,
  },
  metricLabel: {
    color: STATUS_COLORS.muted,
    fontSize: 12,
  },
  metricValue: {
    color: STATUS_COLORS.ink,
    fontSize: 18,
    fontWeight: "600",
    marginTop: 3,
  },
  metricWide: {
    width: "49%",
  },
  metrics: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  notice: {
    borderLeftColor: STATUS_COLORS.teal,
    borderLeftWidth: 3,
    marginTop: 28,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  noticeText: {
    color: STATUS_COLORS.muted,
    fontSize: 13,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: STATUS_COLORS.teal,
    borderRadius: 6,
    flexDirection: "row",
    height: 42,
    justifyContent: "center",
    opacity: 0.48,
    paddingHorizontal: 18,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 8,
  },
  productName: {
    color: STATUS_COLORS.ink,
    fontSize: 19,
    fontWeight: "700",
  },
  safeArea: {
    backgroundColor: STATUS_COLORS.surface,
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  section: {
    width: "100%",
  },
  sectionTitle: {
    color: STATUS_COLORS.ink,
    fontSize: 15,
    fontWeight: "600",
    marginBottom: 12,
    marginTop: 28,
  },
  shell: {
    flex: 1,
  },
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
  statusCopy: {
    flex: 1,
    paddingRight: 16,
  },
  statusDetail: {
    color: STATUS_COLORS.muted,
    fontSize: 14,
    marginTop: 8,
  },
  statusIcon: {
    alignItems: "center",
    backgroundColor: STATUS_COLORS.surface,
    borderRadius: 6,
    height: 52,
    justifyContent: "center",
    width: 52,
  },
  statusTitle: {
    color: STATUS_COLORS.ink,
    fontSize: 22,
    fontWeight: "600",
    marginTop: 7,
  },
  tab: {
    alignItems: "center",
    borderBottomColor: "transparent",
    borderBottomWidth: 2,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 18,
  },
  tabActive: {
    borderBottomColor: STATUS_COLORS.teal,
  },
  tabText: {
    color: STATUS_COLORS.muted,
    fontSize: 14,
    fontWeight: "500",
  },
  tabTextActive: {
    color: STATUS_COLORS.ink,
    fontWeight: "600",
  },
  tabs: {
    backgroundColor: STATUS_COLORS.panel,
    borderBottomColor: STATUS_COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    paddingHorizontal: 10,
  },
  version: {
    color: STATUS_COLORS.muted,
    fontSize: 11,
    marginTop: 2,
  },
});
