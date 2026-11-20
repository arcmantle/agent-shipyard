using AgentLogbook.Core.Entities;

namespace AgentLogbook.Core.Tests.Entities;

public class EntityRulesTests
{
	[Test]
	[Arguments("project", "draft")]
	[Arguments("epic", "draft")]
	[Arguments("initiative", "draft")]
	[Arguments("prd", "draft")]
	[Arguments("userStory", "draft")]
	[Arguments("adr", "current")]
	[Arguments("issue", "todo")]
	[Arguments("debt", "open")]
	[Arguments("handoff", "active")]
	[Arguments("plan", "draft")]
	public async Task Every_kind_starts_with_the_first_status_of_its_flow(string kind, string initial)
	{
		await Assert.That(EntityRules.IsKind(kind)).IsTrue();
		await Assert.That(EntityRules.InitialStatus(kind)).IsEqualTo(initial);
		await Assert.That(EntityRules.IsValidStatus(kind, initial)).IsTrue();
	}

	[Test]
	public async Task A_status_is_valid_only_in_the_flow_of_its_kind()
	{
		await Assert.That(EntityRules.IsValidStatus("issue", "in-progress")).IsTrue();
		await Assert.That(EntityRules.IsValidStatus("initiative", "todo")).IsFalse();
		await Assert.That(EntityRules.IsKind("bogus")).IsFalse();
		await Assert.That(EntityRules.IsKind(null)).IsFalse();
		await Assert.That(EntityRules.IsKind("Issue")).IsFalse();
	}

	[Test]
	public async Task The_parent_relation_is_the_first_allowed_relation_of_the_pair()
	{
		await Assert.That(EntityRules.AllowedRelationType("epic", "initiative")).IsEqualTo("contains");
		await Assert.That(EntityRules.AllowedRelationType("initiative", "issue")).IsEqualTo("tracks");
		await Assert.That(EntityRules.AllowedRelationType("issue", "issue")).IsEqualTo("decomposes");
		await Assert.That(EntityRules.AllowedRelationType("issue", "debt")).IsEqualTo("records");
		await Assert.That(EntityRules.AllowedRelationType("initiative", "epic")).IsNull();
		await Assert.That(EntityRules.IsStructuralRelationType("tracks")).IsTrue();
		await Assert.That(EntityRules.IsStructuralRelationType("blocks")).IsFalse();
	}

	[Test]
	public async Task Categories_priorities_and_types_are_checked_against_the_workflow()
	{
		await Assert.That(EntityRules.IsCategory("technical")).IsTrue();
		await Assert.That(EntityRules.IsCategory("bogus")).IsFalse();
		await Assert.That(EntityRules.IsPriority("critical")).IsTrue();
		await Assert.That(EntityRules.IsPriority("urgent")).IsFalse();
		await Assert.That(EntityRules.IsType("issue", "pioneer-map")).IsTrue();
		await Assert.That(EntityRules.IsType("initiative", "pioneer-map")).IsFalse();
	}

	[Test]
	[Arguments("  title  ", "title")]
	[Arguments("\t\n title \r\n", "title")]
	[Arguments("\u00a0\ufefftitle\u3000", "title")]
	[Arguments("\u0085title", "\u0085title")]
	[Arguments("   ", "")]
	[Arguments("", "")]
	[Arguments("a  b", "a  b")]
	public async Task A_title_is_trimmed_like_javascript_trims_it(string input, string expected) =>
		await Assert.That(JavaScriptWhiteSpace.Trim(input)).IsEqualTo(expected);
}
