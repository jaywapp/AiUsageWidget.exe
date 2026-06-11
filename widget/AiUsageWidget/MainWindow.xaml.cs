using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Brush = System.Windows.Media.Brush;

namespace AiUsageWidget;

public partial class MainWindow : Window
{
    private const int Port = 4789;
    private const double BarWidth = 206; // Viewbox 내부 디자인 폭 (StackPanel Width와 일치)

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(3) };

    private readonly DispatcherTimer _timer;
    private readonly DispatcherTimer _saveDebounce;
    private readonly Settings _settings;
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

        _settings = Settings.Load();
        Width = _settings.Width;
        Height = _settings.Height;

        var wa = SystemParameters.WorkArea;
        if (double.IsNaN(_settings.Left) || double.IsNaN(_settings.Top) ||
            _settings.Left < SystemParameters.VirtualScreenLeft - 50 ||
            _settings.Left > SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth - 50 ||
            _settings.Top < SystemParameters.VirtualScreenTop - 50 ||
            _settings.Top > SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight - 50)
        {
            Left = wa.Right - Width - 12;
            Top = wa.Top + 12;
        }
        else
        {
            Left = _settings.Left;
            Top = _settings.Top;
        }

        MouseLeftButtonDown += (_, _) => { try { DragMove(); } catch { /* 클릭 타이밍에 따라 발생 가능 */ } };

        SetupTray();
        SetupWidgetContextMenu();

        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(_settings.RefreshSeconds) };
        _timer.Tick += async (_, _) => await UpdateAsync();
        _timer.Start();

        // 크기/위치 변경 1초 후 저장 (디바운스)
        _saveDebounce = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _saveDebounce.Tick += (_, _) =>
        {
            _saveDebounce.Stop();
            _settings.Width = Width;
            _settings.Height = Height;
            _settings.Left = Left;
            _settings.Top = Top;
            _settings.Save();
        };
        SizeChanged += (_, _) => { _saveDebounce.Stop(); _saveDebounce.Start(); };
        LocationChanged += (_, _) => { _saveDebounce.Stop(); _saveDebounce.Start(); };

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
        menu.Items.Add("설정", null, (_, _) => OpenSettings());
        menu.Items.Add("대시보드 열기", null, (_, _) =>
            Process.Start(new ProcessStartInfo($"http://localhost:{Port}") { UseShellExecute = true }));
        menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
        menu.Items.Add("종료", null, (_, _) => ExitApp());
        _tray.ContextMenuStrip = menu;
        _tray.DoubleClick += (_, _) => ToggleVisibility();
    }

    // 위젯 우클릭 메뉴 — 트레이 메뉴와 동일 구성
    private void SetupWidgetContextMenu()
    {
        var menu = new System.Windows.Controls.ContextMenu();

        System.Windows.Controls.MenuItem Item(string header, Action action)
        {
            var mi = new System.Windows.Controls.MenuItem { Header = header };
            mi.Click += (_, _) => action();
            return mi;
        }

        menu.Items.Add(Item("위젯 표시/숨기기", ToggleVisibility));
        menu.Items.Add(Item("설정", OpenSettings));
        menu.Items.Add(Item("대시보드 열기", () =>
            Process.Start(new ProcessStartInfo($"http://localhost:{Port}") { UseShellExecute = true })));
        menu.Items.Add(new System.Windows.Controls.Separator());
        menu.Items.Add(Item("종료", ExitApp));

        ContextMenu = menu;
    }

    private void ToggleVisibility()
    {
        if (IsVisible) Hide();
        else { Show(); Topmost = true; }
    }

    private void OpenSettings()
    {
        if (!IsVisible) Show();
        var dlg = new SettingsWindow(_settings) { Owner = this };
        if (dlg.ShowDialog() == true)
        {
            Width = _settings.Width;
            Height = _settings.Height;
            _timer.Interval = TimeSpan.FromSeconds(_settings.RefreshSeconds);
            _settings.Save();
        }
    }

    private void ExitApp()
    {
        _exiting = true;
        _timer.Stop();
        _settings.Width = Width;
        _settings.Height = Height;
        _settings.Left = Left;
        _settings.Top = Top;
        _settings.Save();
        if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
        System.Windows.Application.Current.Shutdown();
    }

    // ---------- 리사이즈 그립 (테두리 없는 창용 Win32 트릭) ----------

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    private void ResizeGrip_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        const int WM_NCLBUTTONDOWN = 0x00A1;
        const int HTBOTTOMRIGHT = 17;
        ReleaseCapture();
        SendMessage(new WindowInteropHelper(this).Handle, WM_NCLBUTTONDOWN, (IntPtr)HTBOTTOMRIGHT, IntPtr.Zero);
        e.Handled = true;
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
