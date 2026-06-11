using System.Globalization;
using System.Windows;
using System.Windows.Input;

namespace AiUsageWidget;

public partial class SettingsWindow : Window
{
    private readonly Settings _settings;

    public SettingsWindow(Settings settings)
    {
        InitializeComponent();
        _settings = settings;

        WidthBox.Text = ((int)settings.Width).ToString(CultureInfo.InvariantCulture);
        HeightBox.Text = ((int)settings.Height).ToString(CultureInfo.InvariantCulture);
        RefreshBox.Text = settings.RefreshSeconds.ToString(CultureInfo.InvariantCulture);

        MouseLeftButtonDown += (_, _) => { try { DragMove(); } catch { } };
        KeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape) { DialogResult = false; Close(); }
            if (e.Key == Key.Enter) Ok_Click(this, new RoutedEventArgs());
        };
    }

    private void Ok_Click(object sender, RoutedEventArgs e)
    {
        if (!double.TryParse(WidthBox.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var w) ||
            !double.TryParse(HeightBox.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var h) ||
            !int.TryParse(RefreshBox.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var r))
        {
            ErrorText.Text = "숫자만 입력하세요.";
            return;
        }

        if (w < Settings.MinW || w > Settings.MaxW || h < Settings.MinH || h > Settings.MaxH)
        {
            ErrorText.Text = $"크기 범위: 너비 {Settings.MinW}~{Settings.MaxW}, 높이 {Settings.MinH}~{Settings.MaxH}";
            return;
        }
        if (r < Settings.MinRefresh || r > Settings.MaxRefresh)
        {
            ErrorText.Text = $"갱신 주기 범위: {Settings.MinRefresh}~{Settings.MaxRefresh}초";
            return;
        }

        _settings.Width = w;
        _settings.Height = h;
        _settings.RefreshSeconds = r;
        DialogResult = true;
        Close();
    }

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }
}
