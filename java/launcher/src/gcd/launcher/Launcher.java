package gcd.launcher;

import gcd.json.Json;
import java.io.IOException;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.lang.management.MemoryUsage;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

public final class Launcher {
    private Launcher() {}

    private static final AtomicReference<Throwable> uncaught = new AtomicReference<>();

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            System.err.println("usage: Launcher <main-class> <metrics-file>");
            System.exit(3);
        }
        String mainClass = args[0];
        Path metricsPath = Paths.get(args[1]);
        long mainThreadId = Thread.currentThread().threadId();
        RuntimeMetrics metrics = new RuntimeMetrics(mainThreadId);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            try {
                writeMetrics(metricsPath, metrics.capture(uncaught.get()));
            } catch (IOException exception) {
                System.err.println("unable to write JVM metrics: " + exception.getMessage());
            }
        }, "gcd-metrics-shutdown"));

        try {
            Class<?> entry = Class.forName(mainClass);
            entry.getMethod("main", String[].class).invoke(null, (Object) new String[0]);
        } catch (Throwable throwable) {
            Throwable cause = throwable instanceof java.lang.reflect.InvocationTargetException &&
                    throwable.getCause() != null ? throwable.getCause() : throwable;
            uncaught.set(cause);
            cause.printStackTrace(System.err);
        } finally {
            metrics.finishMainThread();
        }
        if (uncaught.get() != null) {
            System.exit(1);
        }
    }

    private static void writeMetrics(Path path, String json) throws IOException {
        Files.createDirectories(path.getParent());
        Path temporary = path.resolveSibling(path.getFileName() + ".tmp");
        Files.writeString(temporary, json, StandardCharsets.UTF_8);
        Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING,
                   StandardCopyOption.ATOMIC_MOVE);
    }

    private static final class RuntimeMetrics {
        private final long mainThreadId;
        private final long startUptimeMs;
        private final com.sun.management.ThreadMXBean allocationBean;
        private final long allocationStart;
        private volatile long allocationTotal = -1;

        RuntimeMetrics(long mainThreadId) {
            this.mainThreadId = mainThreadId;
            this.startUptimeMs = ManagementFactory.getRuntimeMXBean().getUptime();
            java.lang.management.ThreadMXBean bean = ManagementFactory.getThreadMXBean();
            if (bean instanceof com.sun.management.ThreadMXBean) {
                allocationBean = (com.sun.management.ThreadMXBean) bean;
                if (allocationBean.isThreadAllocatedMemorySupported() &&
                        !allocationBean.isThreadAllocatedMemoryEnabled()) {
                    allocationBean.setThreadAllocatedMemoryEnabled(true);
                }
                allocationStart = allocationBean.isThreadAllocatedMemoryEnabled()
                        ? allocationBean.getThreadAllocatedBytes(mainThreadId) : -1;
            } else {
                allocationBean = null;
                allocationStart = -1;
            }
        }

        void finishMainThread() {
            long current = currentAllocationCount();
            allocationTotal = current < 0 || allocationStart < 0
                    ? -1 : Math.max(0, current - allocationStart);
        }

        String capture(Throwable throwable) {
            long uptime = ManagementFactory.getRuntimeMXBean().getUptime();
            long allocatedBytes = allocationTotal >= 0
                    ? allocationTotal : currentAllocationCount();
            long heapPeakUsed = heapPeakUsed();
            StringBuilder json = new StringBuilder("{\"jvmUptimeMs\":")
                    .append(Math.max(0, uptime - startUptimeMs))
                    .append(",\"allocatedBytesMainThread\":");
            if (allocatedBytes < 0) json.append("null");
            else json.append(allocatedBytes);
            json.append(",\"heapPeakUsed\":").append(heapPeakUsed).append(",\"collectors\":[");
            List<GarbageCollectorMXBean> collectors =
                    ManagementFactory.getGarbageCollectorMXBeans();
            for (int i = 0; i < collectors.size(); i++) {
                GarbageCollectorMXBean collector = collectors.get(i);
                if (i > 0) json.append(',');
                json.append("{\"name\":").append(Json.quote(collector.getName()))
                        .append(",\"count\":").append(collector.getCollectionCount())
                        .append(",\"timeMs\":").append(collector.getCollectionTime()).append('}');
            }
            json.append(']');
            if (throwable != null) {
                json.append(",\"exception\":{\"className\":")
                        .append(Json.quote(throwable.getClass().getName()))
                        .append(",\"message\":")
                        .append(Json.quote(String.valueOf(throwable.getMessage())))
                        .append(",\"stackTop\":[");
                StackTraceElement[] stack = throwable.getStackTrace();
                for (int i = 0; i < Math.min(stack.length, 20); i++) {
                    if (i > 0) json.append(',');
                    json.append(Json.quote(stack[i].toString()));
                }
                json.append("]}");
            }
            return json.append('}').toString();
        }

        private long currentAllocationCount() {
            if (allocationBean == null || allocationStart < 0 ||
                    !allocationBean.isThreadAllocatedMemoryEnabled()) {
                return -1;
            }
            long current = allocationBean.getThreadAllocatedBytes(mainThreadId);
            return current < 0 ? -1 : Math.max(0, current - allocationStart);
        }

        private long heapPeakUsed() {
            long sum = 0;
            for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
                if (pool.getType() != MemoryType.HEAP) continue;
                MemoryUsage peak = pool.getPeakUsage();
                if (peak != null) sum += peak.getUsed();
            }
            return sum;
        }
    }
}
