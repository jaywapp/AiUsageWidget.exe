using System.Threading;
using System.Windows;

namespace AiUsageWidget;

public partial class App : System.Windows.Application
{
    private Mutex? _mutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        _mutex = new Mutex(true, "AiUsageWidgetNet", out bool created);
        if (!created)
        {
            Shutdown();
            return;
        }

        base.OnStartup(e);
        new MainWindow().Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _mutex?.ReleaseMutex();
        base.OnExit(e);
    }
}
