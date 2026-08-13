using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OiProctor {
  sealed class LoginConfig {
    public string server = "http://192.168.1.149:3000";
    public int contestId;
    public string studentId = "";
    public string studentToken = "";
    public static LoginConfig Load() {
      try {
        byte[] data = File.ReadAllBytes(Application.ExecutablePath);
        byte[] marker = Encoding.UTF8.GetBytes("\nOI_PROCTOR_CONFIG_V1\n");
        for (int i = data.Length - marker.Length; i >= 0; i--) {
          bool match = true;
          for (int j = 0; j < marker.Length; j++) if (data[i + j] != marker[j]) { match = false; break; }
          if (!match) continue;
          string config = Encoding.UTF8.GetString(data, i + marker.Length, data.Length - i - marker.Length);
          return new JavaScriptSerializer().Deserialize<LoginConfig>(config) ?? new LoginConfig();
        }
      } catch { }
      return new LoginConfig();
    }
  }

  static class Program {
    [STAThread] static void Main() {
      ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
      Application.Run(new SetupForm(LoginConfig.Load()));
    }
  }

  sealed class SetupForm : Form {
    readonly TextBox server = new TextBox();
    readonly TextBox contest = new TextBox(); readonly TextBox student = new TextBox();
    readonly TextBox token = new TextBox { UseSystemPasswordChar = true };
    readonly CheckBox consent = new CheckBox { AutoSize = true, Text = "我知道考试期间会上传屏幕缩略图和正在运行的可见程序名称" };
    readonly Button start = new Button { Text = "连接并开始监考", AutoSize = true };
    public SetupForm(LoginConfig config) {
      server.Text = config.server; contest.Text = config.contestId > 0 ? config.contestId.ToString() : "";
      student.Text = config.studentId; token.Text = config.studentToken;
      Text = "OI 赛场监考客户端"; Width = 590; Height = 390; StartPosition = FormStartPosition.CenterScreen;
      var panel = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 2, RowCount = 7 };
      panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120)); panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
      panel.Controls.Add(new Label { Text = "监考说明", AutoSize = true, Font = new Font(Font, FontStyle.Bold) }, 0, 0);
      panel.Controls.Add(new Label { Text = "本程序会定时发送屏幕缩略图和可见程序名称。发现违规软件时会提醒本人并上报管理员，持续违规时每隔 30 秒截图。不会记录键盘输入，也不会开机自启。", AutoSize = true, MaximumSize = new Size(390, 0) }, 1, 0);
      Add(panel, "服务器地址", server, 1); Add(panel, "比赛编号", contest, 2); Add(panel, "考号", student, 3); Add(panel, "个人提交码", token, 4);
      panel.Controls.Add(consent, 1, 5); panel.Controls.Add(start, 1, 6); Controls.Add(panel);
      start.Click += async delegate { await StartAsync(); };
    }
    static void Add(TableLayoutPanel p, string label, Control input, int row) { p.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row); input.Dock = DockStyle.Fill; p.Controls.Add(input, 1, row); }
    async Task StartAsync() {
      if (!consent.Checked) { MessageBox.Show("请先阅读并确认监考说明。"); return; }
      int contestId;
      if (!int.TryParse(contest.Text.Trim(), out contestId)) { MessageBox.Show("比赛编号必须填写管理员页面显示的数字，例如 test 是 #3，就填写 3，不能填写 test。"); return; }
      if (string.IsNullOrWhiteSpace(student.Text) || string.IsNullOrWhiteSpace(token.Text)) { MessageBox.Show("请完整填写考号和个人提交码。"); return; }
      string serverAddress = server.Text.Trim();
      if (!serverAddress.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !serverAddress.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) serverAddress = "http://" + serverAddress;
      Uri parsedServer; if (!Uri.TryCreate(serverAddress, UriKind.Absolute, out parsedServer)) { MessageBox.Show("服务器地址无效，例如：http://192.168.31.74:3000"); return; }
      start.Enabled = false;
      var monitor = new MonitorForm(serverAddress.TrimEnd('/'), contestId, student.Text.Trim(), token.Text.Trim());
      try { await monitor.ConnectAsync(); Hide(); monitor.FormClosed += delegate { Close(); }; monitor.Show(); monitor.OpenExamBrowser(); }
      catch (Exception error) { monitor.Dispose(); MessageBox.Show("连接失败：" + error.Message); start.Enabled = true; }
    }
  }

  sealed class MonitorForm : Form {
    readonly string server, student, token; readonly int contestId; readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
    readonly string edgeProfile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OI-Proctor-Edge");
    readonly Timer timer = new Timer { Interval = 3000 }; readonly Label status = new Label { Dock = DockStyle.Fill, AutoSize = true };
    readonly JavaScriptSerializer json = new JavaScriptSerializer(); bool sending, canExit, warningShown;
    DateTime nextScreenshot = DateTime.MinValue;
    const int EdgeDebugPort = 9223;
    static readonly HashSet<string> Allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "proctor-client", "code", "devcpp", "notepad", "msedge", "explorer", "applicationframehost", "shellexperiencehost", "searchhost", "startmenuexperiencehost", "textinputhost", "systemsettings", "taskhostw" };
    static readonly HashSet<string> ReportedAllowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "code", "devcpp", "notepad", "msedge" };
    static readonly HashSet<string> Forbidden = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "qq", "tim", "wechat", "weixin", "wxwork", "telegram", "discord", "chrome", "firefox", "opera", "360se", "360chrome", "powershell", "pwsh", "cmd", "windowsterminal", "mstsc", "teamviewer", "anydesk", "sunloginclient", "todesk", "taskmgr" };
    public MonitorForm(string server, int contestId, string student, string token) {
      this.server = server; this.contestId = contestId; this.student = student; this.token = token;
      Text = "OI 监考中 - " + student; Width = 460; Height = 180; StartPosition = FormStartPosition.CenterScreen; TopMost = true;
      status.Text = "正在连接监考服务器…"; status.Padding = new Padding(20); Controls.Add(status);
      timer.Tick += async delegate { await TickAsync(); };
      FormClosing += delegate(object sender, FormClosingEventArgs e) {
        if (!canExit) { e.Cancel = true; MessageBox.Show("尚未提交答案，监考客户端不能退出。提交成功后服务器会自动允许退出。", "监考进行中"); return; }
        timer.Stop();
      };
    }
    public async Task ConnectAsync() { await SendAsync(new string[0], ""); timer.Start(); status.Text = "监考已连接。请勿关闭本窗口；管理员可以看到在线状态和屏幕缩略图。"; }
    public void OpenExamBrowser() {
      if (ExamEdgeWindowRunning() && EdgeDebugReady()) return;
      string edge = Environment.ExpandEnvironmentVariables(@"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe");
      if (!File.Exists(edge)) edge = Environment.ExpandEnvironmentVariables(@"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe");
      if (!File.Exists(edge)) throw new Exception("找不到 Microsoft Edge，无法打开考试网页");
      foreach (var process in Process.GetProcessesByName("msedge")) {
        try { process.Kill(); process.WaitForExit(1500); } catch { }
      }
      Directory.CreateDirectory(edgeProfile);
      string args = "--user-data-dir=\"" + edgeProfile + "\" --remote-debugging-address=127.0.0.1 --remote-debugging-port=" + EdgeDebugPort + " --no-first-run --disable-extensions --app=\"" + server + "\" --start-maximized";
      Process.Start(new ProcessStartInfo(edge, args) { UseShellExecute = false });
    }
    async Task TickAsync() {
      if (sending) return; sending = true;
      try {
        string[] visible = new string[0];
        string violation = InspectPrograms(out visible);
        if (violation.Length == 0) violation = await InspectExamEdgeTabsAsync();
        bool due = DateTime.Now >= nextScreenshot;
        bool captureNow = due;
        if (violation.Length > 0 && (due || !warningShown)) {
          warningShown = true; nextScreenshot = DateTime.Now.AddSeconds(30);
          captureNow = true;
          MessageBox.Show(violation + "\r\n\r\n请立即关闭违规软件。若仍不处理，系统每隔 30 秒截图上报管理员。", "监考违规提醒", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        } else if (violation.Length == 0) {
          warningShown = false;
          if (due) nextScreenshot = DateTime.Now.AddSeconds(30);
        }
        await SendAsync(visible, violation, captureNow);
        string countdown = " · 下次截图 " + Math.Max(1, (int)Math.Ceiling((nextScreenshot - DateTime.Now).TotalSeconds)) + " 秒后";
        status.Text = "监考在线 · 最近上报 " + DateTime.Now.ToString("HH:mm:ss") + (violation.Length > 0 ? " · 已发现违规" : "") + countdown;
      } catch (Exception error) { status.Text = "监考服务器连接异常：" + error.Message; }
      finally { sending = false; }
    }
    string InspectPrograms(out string[] names) {
      var visible = Native.VisibleProcesses().Where(p => p.Id != Process.GetCurrentProcess().Id).GroupBy(p => p.ProcessName, StringComparer.OrdinalIgnoreCase).Select(g => g.First()).ToList();
      names = visible.Where(p => ReportedAllowed.Contains(p.ProcessName) || Forbidden.Contains(p.ProcessName))
        .Select(p => p.ProcessName.Equals("msedge", StringComparison.OrdinalIgnoreCase) ? IsExamEdge(p) ? "Edge（考试/PDF）" : "Edge" : p.ProcessName)
        .OrderBy(x => x).Take(20).ToArray();
      foreach (var process in visible) {
        string name = process.ProcessName;
        if (name.Equals("msedge", StringComparison.OrdinalIgnoreCase) && IsExamEdge(process)) continue;
        if (Allowed.Contains(name)) continue;
        if (Forbidden.Contains(name) || process.MainWindowHandle != IntPtr.Zero) {
          return "发现未获准程序：" + name;
        }
      }
      return "";
    }
    async Task<string> InspectExamEdgeTabsAsync() {
      try {
        string source = await http.GetStringAsync("http://127.0.0.1:" + EdgeDebugPort + "/json");
        object[] tabs = json.Deserialize<object[]>(source) ?? new object[0];
        foreach (Dictionary<string, object> tab in tabs.OfType<Dictionary<string, object>>()) {
          if (Convert.ToString(tab.ContainsKey("type") ? tab["type"] : "") != "page") continue;
          string url = Convert.ToString(tab.ContainsKey("url") ? tab["url"] : "");
          if (!AllowedExamUrl(url)) return "Edge 进入了未获准地址：" + DisplayAddress(url);
        }
      } catch { }
      return "";
    }
    bool AllowedExamUrl(string value) {
      if (string.IsNullOrWhiteSpace(value)) return true;
      if (value.StartsWith("blob:", StringComparison.OrdinalIgnoreCase)) value = value.Substring(5);
      Uri page;
      if (!Uri.TryCreate(value, UriKind.Absolute, out page)) return false;
      if (page.IsFile || page.Scheme == "edge" || page.Scheme == "about" || page.Scheme == "data") return true;
      Uri exam = new Uri(server);
      return page.Scheme == exam.Scheme && page.Host.Equals(exam.Host, StringComparison.OrdinalIgnoreCase) && page.Port == exam.Port;
    }
    static string DisplayAddress(string value) {
      Uri uri;
      if (value.StartsWith("blob:", StringComparison.OrdinalIgnoreCase)) value = value.Substring(5);
      return Uri.TryCreate(value, UriKind.Absolute, out uri) ? uri.Scheme + "://" + uri.Authority : value.Substring(0, Math.Min(80, value.Length));
    }
    static bool EdgeDebugReady() {
      try {
        var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + EdgeDebugPort + "/json/version");
        request.Timeout = 500;
        using (request.GetResponse()) return true;
      } catch { return false; }
    }
    bool IsExamEdge(Process process) {
      try {
        int processId = process.Id;
        for (int depth = 0; depth < 32 && processId > 0; depth++) {
          if (Native.CommandLine(processId).IndexOf(edgeProfile, StringComparison.OrdinalIgnoreCase) >= 0) return true;
          int parent = Native.ParentProcessId(processId);
          if (parent == processId) break;
          processId = parent;
        }
        return false;
      }
      catch { return false; }
    }
    bool ExamEdgeWindowRunning() { return Process.GetProcessesByName("msedge").Any(process => process.MainWindowHandle != IntPtr.Zero && IsExamEdge(process)); }
    async Task SendAsync(string[] processes, string violation, bool includeScreen = true) {
      string screenshot = includeScreen ? Convert.ToBase64String(CaptureScreen()) : null;
      var body = json.Serialize(new { screen = screenshot, processes = processes, violation = violation });
      string url = server + "/api/proctor/heartbeat?contestId=" + contestId + "&studentId=" + Uri.EscapeDataString(student);
      using (var request = new HttpRequestMessage(HttpMethod.Post, url)) {
        request.Headers.Add("x-student-token", token); request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        using (var response = await http.SendAsync(request)) {
        string text = await response.Content.ReadAsStringAsync(); if (!response.IsSuccessStatusCode) throw new Exception(text);
        var result = json.Deserialize<Dictionary<string, object>>(text);
        bool exitNow = Convert.ToBoolean(result["canExit"]);
        if (exitNow && !canExit) status.Text = "已检测到提交成功，现在可以关闭监考客户端。";
        canExit = exitNow;
        if (!ExamEdgeWindowRunning()) OpenExamBrowser();
        }
      }
    }
    static byte[] CaptureScreen() {
      var bounds = Screen.PrimaryScreen.Bounds; int width = Math.Min(900, bounds.Width), height = bounds.Height * width / bounds.Width;
      using (var full = new Bitmap(bounds.Width, bounds.Height)) using (var g = Graphics.FromImage(full)) using (var small = new Bitmap(width, height)) using (var output = new MemoryStream()) {
        g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size); using (var sg = Graphics.FromImage(small)) sg.DrawImage(full, 0, 0, width, height);
        var codec = ImageCodecInfo.GetImageEncoders().First(x => x.FormatID == ImageFormat.Jpeg.Guid); using (var parameters = new EncoderParameters(1)) { parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 35L); small.Save(output, codec, parameters); }
        return output.ToArray();
      }
    }
  }

  static class Native {
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    public static IEnumerable<Process> VisibleProcesses() { var ids = new HashSet<uint>(); EnumWindows(delegate(IntPtr h, IntPtr l) { if (IsWindowVisible(h)) { uint id; GetWindowThreadProcessId(h, out id); if (id > 0) ids.Add(id); } return true; }, IntPtr.Zero); foreach (uint id in ids) { Process p = null; try { p = Process.GetProcessById((int)id); } catch { } if (p != null) yield return p; } }
    public static string CommandLine(int processId) { using (var searcher = new System.Management.ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + processId)) foreach (System.Management.ManagementObject item in searcher.Get()) return Convert.ToString(item["CommandLine"]); return ""; }
    public static int ParentProcessId(int processId) { using (var searcher = new System.Management.ManagementObjectSearcher("SELECT ParentProcessId FROM Win32_Process WHERE ProcessId=" + processId)) foreach (System.Management.ManagementObject item in searcher.Get()) return Convert.ToInt32(item["ParentProcessId"]); return 0; }
  }
}
