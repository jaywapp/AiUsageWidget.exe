using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Brush = System.Windows.Media.Brush;

namespace AiUsageWidget;

public partial class MainWindow : Window
{
    private const int Port = 4789;
    private const double BarWidth = 204; // 232 - 26(padding) - 2(border)

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(3) };

    private readonly DispatcherTimer _timer;
    private System.Windows.Forms.NotifyIcon? _tray;
    private bool _exiting;

    private static readonly Brush BrClaude = FromHex("#D97757");
    private static readonly Brush BrCodex = FromHex("#4F9CF9");
    private static readonly Brush BrWarn = FromHex("#E4B54C");
    private static readonly Brush BrDanger = FromHex("#E0564F");
    private static readonly Brush BrGreen = FromHex("#46C481");

    public MainWindow()
    {
        InitializeComponent();

        var wa = SystemParameters.WorkArea;
        Left = wa.Right - Width - 12;
        Top = wa.Top + 12;

        MouseLeftButtonDown += (_, _) => { try { DragMove(); } catch { /* 클릭 타이밍에 따라 발생 가능 */ } };

        SetupTray();

        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(15) };
        _timer.Tick += async (_, _) => await UpdateAsync();
        _timer.Start();

        Loaded += async (_, _) =>
        {
            await EnsureServerAsync();
            await UpdateAsync();
        };

        Closing += (_, e) =>
        {
            if (_exiting) return;
            e.Cancel = true; // X / Alt+F4 → 트레이로 숨김
            Hide();
        };
    }

    private static Brush FromHex(string hex) =>
        (Brush)new BrushConverter().ConvertFromString(hex)!;

    // ---------- 트레이 ----------

    private void SetupTray()
    {
        var bmp = new System.Drawing.Bitmap(16, 16);
        using (var g = System.Drawing.Graphics.FromImage(bmp))
        {
            g.Clear(System.Drawing.Color.FromArgb(217, 119, 87));
            using var font = new System.Drawing.Font("Segoe UI", 9, System.Drawing.FontStyle.Bold);
            g.DrawString("A", font, System.Drawing.Brushes.White, 0, 0);
        }

        _tray = new System.Windows.Forms.NotifyIcon
        {
            Icon = System.Drawing.Icon.FromHandle(bmp.GetHicon()),
            Text = "AI 사용량 위젯",
            Visible = true,
        };

        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.Add("위젯 표시/숨기기", null, (_, _) => ToggleVisibility());
        menu.Items.Add("대시보드 열기", null, (_, _) =>
            Process.Start(new ProcessStartInfo($"http://localhost:{Port}") { UseShellExecute = true }));
        menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
        menu.Items.Add("종료", null, (_, _) => ExitApp());
        _tray.ContextMenuStrip = menu;
        _tray.DoubleClick += (_, _) => ToggleVisibility();
    }

    private void ToggleVisibility()
    {
        if (IsVisible) Hide();
        else { Show(); Topmost = true; }
    }

    private void ExitApp()
    {
        _exiting = true;
        _timer.Stop();
        if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
        System.Windows.Application.Current.Shutdown();
    }

    // ---------- 서버 ----------

    private static string? FindServerJs()
    {
        // exe 위치에서 상위로 올라가며 server.js 탐색 (widget\AiUsageWidget\bin\... → 대시보드 루트)
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "server.js");
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        return null;
    }

    private static async Task<bool> IsServerAliveAsync()
    {
        try
        {
            using var res = await Http.GetAsync($"http://localhost:{Port}/api/summary");
            return res.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    private static async Task EnsureServerAsync()
    {
        if (await IsServerAliveAsync()) return;
        var serverJs = FindServerJs();
        if (serverJs == null) return;
        try
        {
            Process.Start(new ProcessStartInfo("node", $"\"{serverJs}\"")
            {
                WorkingDirectory = Path.GetDirectoryName(serverJs)!,
                CreateNoWindow = true,
                UseShellExecute = false,
            });
        }
        catch { return; }

        for (var i = 0; i < 20; i++)
        {
            await Task.Delay(500);
            if (await IsServerAliveAsync()) return;
        }
    }

    // ---------- 데이터 ----------

    private async Task UpdateAsync()
    {
        JsonNode? root;
        try
        {
            var json = await Http.GetStringAsync($"http://localhost:{Port}/api/summary");
            root = JsonNode.Parse(json);
        }
        catch
        {
            LiveText.Text = "offline";
            LiveText.Foreground = BrWarn;
            _ = EnsureServerAsync();
            return;
        }
        if (root == null) return;

        try
        {
            var today = root["kpi"]!["today"]!;
            var todayTokens = D(today, "claude", "tokens") + D(today, "codex", "tokens");
            var todayCost = D(today, "claude", "cost") + D(today, "codex", "cost");
            TodayText.Text = FmtTokens(todayTokens);
            CostText.Text = $"${todayCost:N2}";

            var claude = root["plan"]!["claude"]!;
            SetGauge(C5Bar, C5Pct, BrClaude, claude["pct5h"]!.GetValue<double>());
            SetGauge(C7Bar, C7Pct, BrClaude, claude["pct7d"]!.GetValue<double>());

            var codex = root["plan"]!["codex"];
            if (codex?["primary"] is JsonNode p)
                SetGauge(X5Bar, X5Pct, BrCodex, p["usedPercent"]!.GetValue<double>());
            if (codex?["secondary"] is JsonNode s)
                SetGauge(X7Bar, X7Pct, BrCodex, s["usedPercent"]!.GetValue<double>());

            var month = root["kpi"]!["month"]!;
            var monthTokens = D(month, "claude", "tokens") + D(month, "codex", "tokens");
            var monthCost = D(month, "claude", "cost") + D(month, "codex", "cost");
            if (_tray != null)
                _tray.Text = Truncate($"AI 사용량 — 이번 달 {FmtTokens(monthTokens)} (${monthCost:N0})", 63);

            LiveText.Text = DateTime.Now.ToString("HH:mm");
            LiveText.Foreground = BrGreen;
        }
        catch
        {
            LiveText.Text = "parse err";
            LiveText.Foreground = BrWarn;
        }
    }

    private static double D(JsonNode node, string source, string field) =>
        node[source]?[field]?.GetValue<double>() ?? 0;

    private void SetGauge(System.Windows.Controls.Border bar, System.Windows.Controls.TextBlock pctText, Brush baseBrush, double pct)
    {
        var p = Math.Clamp(pct, 0, 100);
        bar.Width = BarWidth * p / 100;
        bar.Background = p >= 90 ? BrDanger : p >= 70 ? BrWarn : baseBrush;
        pctText.Text = $"{p:N0}%";
    }

    private static string FmtTokens(double n)
    {
        if (n >= 1e9) return $"{n / 1e9:N2}B";
        if (n >= 1e6) return $"{n / 1e6:N1}M";
        if (n >= 1e3) return $"{n / 1e3:N1}K";
        return $"{n:N0}";
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
