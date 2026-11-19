using AgentLogbook.Hosting;

var builder = DistributedApplication.CreateBuilder(args);

builder.AddAgentLogbook();

builder.Build().Run();

public partial class Program;
