using AgentLogbook.Core.WorkflowSchema;

namespace AgentLogbook.Core.Tests.WorkflowSchema;

public class WorkflowSchemaTests
{
	private static AgentLogbook.Core.WorkflowSchema.WorkflowSchema Schema => AgentLogbook.Core.WorkflowSchema.WorkflowSchema.Current;

	[Test]
	public async Task Every_entity_kind_starts_in_the_first_status_and_archives_to_a_listed_status()
	{
		await Assert.That(Schema.EntityKinds).IsNotEmpty();
		foreach (var kind in Schema.EntityKinds)
		{
			await Assert.That(kind.Statuses[0]).IsEqualTo(kind.InitialStatus);
			await Assert.That(kind.Statuses).Contains(kind.ArchiveStatus);
		}
	}

	[Test]
	public async Task Relation_types_are_the_sorted_distinct_types_of_the_allowed_relations()
	{
		var expected = Schema.AllowedRelations.Select(relation => relation.Type).Distinct().Order(StringComparer.Ordinal).ToList();

		await Assert.That(Schema.RelationTypes).IsEquivalentTo(expected);
	}

	[Test]
	public async Task Parent_rules_are_the_allowed_relations_with_a_structural_type()
	{
		var expected = Schema.AllowedRelations
			.Where(relation => Schema.StructuralRelationTypes.Contains(relation.Type))
			.Select(relation => new ParentRule(relation.FromKind, relation.ToKind, relation.Type))
			.ToList();

		await Assert.That(Schema.ParentRules).IsEquivalentTo(expected);
	}

	[Test]
	public async Task Allowed_relations_name_known_entity_kinds()
	{
		var kinds = Schema.EntityKinds.Select(kind => kind.Kind).ToHashSet();

		foreach (var relation in Schema.AllowedRelations)
		{
			await Assert.That(kinds).Contains(relation.FromKind);
			await Assert.That(kinds).Contains(relation.ToKind);
		}
	}

	[Test]
	public async Task The_schema_names_the_tool_command_and_no_old_command_name()
	{
		var commands = new[]
		{
			Schema.Context.ListCommand, Schema.Context.ReadCommand, Schema.IssueComments.AddCommand, Schema.PlanEntries.AddCommand,
		};

		await Assert.That(commands).All().Satisfy(command => command.StartsWith("agent-logbook ", StringComparison.Ordinal));
	}
}
