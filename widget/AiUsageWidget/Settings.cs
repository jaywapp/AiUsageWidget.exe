using System.IO;
using System.Text.Json;

namespace AiUsageWidget;

public class Settings
{
    public const double MinW = 170, MaxW = 1200, MinH = 140, MaxH = 1000;
    public const int MinRefresh = 5, MaxRefresh = 600;

    public double Width { get; set; } = 232;
    public double Height { get; set; } = 178;
    public double Left { get; set; } = double.NaN;
    public double Top { get; set; } = double.NaN;
    public int RefreshSeconds { get; set; } = 15;

    private static string Dir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AiUsageWidget");

    private static string FilePath => Path.Combine(Dir, "settings.json");

    public static Settings Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var s = JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath));
                if (s != null) { s.Clamp(); return s; }
            }
        }
        catch { /* 손상 시 기본값 */ }
        return new Settings();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { /* 저장 실패는 무시 */ }
    }

    public void Clamp()
    {
        Width = Math.Clamp(Width, MinW, MaxW);
        Height = Math.Clamp(Height, MinH, MaxH);
        RefreshSeconds = Math.Clamp(RefreshSeconds, MinRefresh, MaxRefresh);
    }
}
