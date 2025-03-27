const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const os = require("os");
const pidusage = require("pidusage");
const si = require("systeminformation"); // Add this package: npm install systeminformation

const app = express();
const server = http.createServer(app);

const frontendURL = "http://localhost:5500"; // Change this to your frontend URL

const io = new Server(server, {
  cors: {
    origin: frontendURL,
    methods: ["GET", "POST"],
  },
});

app.use(cors({ origin: frontendURL }));

// Store previous network stats for delta calculation
let previousNetworkStats = {
  rx: 0,
  tx: 0,
};

// Cache system info
let systemInfo = null;

async function getSystemInfo() {
  if (!systemInfo) {
    const cpus = os.cpus();
    systemInfo = {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      cpus: cpus,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpuModel: cpus[0].model,
      cpuSpeed: cpus[0].speed,
      loadavg: os.loadavg(),
    };
  }
  return systemInfo;
}

async function getNetworkStats() {
  const stats = await si.networkStats();
  const total = stats.reduce(
    (acc, iface) => {
      if (!iface.isLoopback) {
        acc.rx += iface.rx_bytes;
        acc.tx += iface.tx_bytes;
      }
      return acc;
    },
    { rx: 0, tx: 0 }
  );

  return total;
}

async function getCoreUsage() {
  try {
    const cpu = await si.currentLoad();
    return cpu.cpus.map((core) => core.load);
  } catch (err) {
    console.error("Error getting CPU core usage:", err);
    return os.cpus().map(() => 0);
  }
}

async function getProcesses() {
  return new Promise((resolve) => {
    const processes = [];
    require("child_process").exec(
      "ps aux --sort=-%cpu | head -15",
      (err, stdout) => {
        if (err) return resolve([]);
        const lines = stdout.split("\n").slice(1);
        lines.forEach((line) => {
          const parts = line.trim().split(/\s+/);
          if (parts.length > 10) {
            processes.push({
              user: parts[0],
              pid: parts[1],
              cpu: parseFloat(parts[2]).toFixed(1),
              mem: parseFloat(parts[3]).toFixed(1),
              command: parts.slice(10).join(" ").substring(0, 100),
              startTime: parts[9],
            });
          }
        });
        resolve(processes);
      }
    );
  });
}

// async function getProcesses() {
//   return new Promise((resolve) => {
//     const powershellCommand = `Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 | Format-Table -Property Id, CPU, WorkingSet, UserName, ProcessName -AutoSize`;

//     require("child_process").exec(
//       `powershell -Command "${powershellCommand}"`,
//       (err, stdout, stderr) => {
//         if (err) {
//           console.error("Error getting processes:", err);
//           return resolve([]);
//         }

//         const processes = [];
//         const lines = stdout.split("\r\n").slice(3); // Skip header lines

//         lines.forEach((line) => {
//           // Clean up the line and split into columns
//           const cleaned = line.trim().replace(/\s+/g, " ");
//           const parts = cleaned.split(" ");

//           if (parts.length >= 5) {
//             processes.push({
//               pid: parts[0],
//               cpu: parseFloat(parts[1]).toFixed(1),
//               mem: (parseFloat(parts[2]) / (1024 * 1024)).toFixed(1), // Convert bytes to MB
//               user: parts[3],
//               command: parts[4],
//             });
//           }
//         });

//         resolve(processes);
//       }
//     );
//   });
// }

// async function getProcesses() {
//   try {
//     const processes = await si.processes();
//     return processes.list
//       .sort((a, b) => b.pcpu - a.pcpu)
//       .slice(0, 15)
//       .map((proc) => ({
//         pid: proc.pid,
//         cpu: proc.pcpu.toFixed(1),
//         mem: proc.pmem.toFixed(1),
//         command: proc.name || proc.command,
//         user: proc.user,
//       }));
//   } catch (err) {
//     console.error("Error getting processes:", err);
//     return [];
//   }
// }

io.on("connection", (socket) => {
  console.log("A client connected:", socket.id);

  // Send initial system info
  getSystemInfo().then((info) => {
    socket.emit("system-info", info);
  });

  // Send system stats every 2 seconds
  //   const sendStats = setInterval(async () => {
  //     try {
  //       const [cpuUsage, memoryUsage, processes, networkStats, coreUsage] =
  //         await Promise.all([
  //           si.currentLoad().then((data) => data.currentload),
  //           si.mem(),
  //           getProcesses(),
  //           getNetworkStats(),
  //           getCoreUsage(),
  //         ]);

  //       const totalMem = os.totalmem();
  //       const usedMemory = totalMem - memoryUsage.free;

  //       socket.emit("system-stats", {
  //         cpuUsage: cpuUsage,
  //         memoryUsage: (usedMemory / totalMem) * 100,
  //         usedMemory: usedMemory,
  //         totalMemory: totalMem,
  //         processes: processes,
  //         systemInfo: await getSystemInfo(),
  //         uptime: os.uptime(),
  //         networkStats: networkStats,
  //         coreUsage: coreUsage,
  //       });
  //     } catch (err) {
  //       console.error("Error collecting system stats:", err);
  //     }
  //   }, 2000);

  const sendStats = setInterval(async () => {
    try {
      const [cpuData, memoryUsage, processes, networkStats, coreUsage] =
        await Promise.all([
          si.currentLoad(),
          si.mem(),
          getProcesses(),
          getNetworkStats(),
          getCoreUsage(),
        ]);

      const totalMem = os.totalmem();
      const usedMemory = totalMem - memoryUsage.free;

      socket.emit("system-stats", {
        cpuUsage: cpuData.currentLoad, // Use currentLoad directly from the object
        memoryUsage: (usedMemory / totalMem) * 100,
        usedMemory: usedMemory,
        totalMemory: totalMem,
        processes: processes,
        systemInfo: await getSystemInfo(),
        uptime: os.uptime(),
        networkStats: networkStats,
        coreUsage: coreUsage,
      });
    } catch (err) {
      console.error("Error collecting system stats:", err);
    }
  }, 1000);

  // Handle process killing
  socket.on("kill-process", (pid) => {
    try {
      process.kill(pid);
      console.log(`Killed process ${pid}`);
    } catch (err) {
      console.error(`Failed to kill process ${pid}:`, err);
    }
  });

  // Handle process details request
  socket.on("get-process-details", (pid, callback) => {
    require("child_process").exec(
      `ps -p ${pid} -o user,pid,%cpu,%mem,command,start`,
      (err, stdout) => {
        if (err) return callback({ error: "Process not found" });

        const lines = stdout.split("\n");
        if (lines.length < 2) return callback({ error: "Process not found" });

        const parts = lines[1].trim().split(/\s+/);
        if (parts.length < 6)
          return callback({ error: "Invalid process data" });

        callback({
          user: parts[0],
          pid: parts[1],
          cpu: parts[2],
          mem: parts[3],
          command: parts.slice(4, -1).join(" "),
          startTime: parts[parts.length - 1],
        });
      }
    );
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    clearInterval(sendStats);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
