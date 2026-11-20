using AgentLogbook.Core.Entities;

namespace AgentLogbook.Core.Tests.Entities;

public class EntityStatusDerivationTests
{
	private static StatusEntity Entity(string id, string kind, string status) => new(id, kind, status);

	private static StatusRelation Relation(string from, string to, string type) => new(from, to, type);

	private static Dictionary<string, string> Derive(StatusEntity[] entities, params StatusRelation[] relations) =>
		EntityStatusDerivation.Derive(entities, relations);

	[Test]
	public async Task An_entity_without_related_work_keeps_its_stored_status()
	{
		var derived = Derive([Entity("i", "issue", "todo"), Entity("p", "project", "draft")]);

		await Assert.That(derived["i"]).IsEqualTo("todo");
		await Assert.That(derived["p"]).IsEqualTo("draft");
	}

	[Test]
	public async Task An_issue_with_an_open_sub_issue_is_blocked_and_with_only_closed_sub_issues_it_is_not()
	{
		var open = Derive([Entity("a", "issue", "todo"), Entity("b", "issue", "todo")], Relation("a", "b", "decomposes"));
		var closed = Derive([Entity("a", "issue", "blocked"), Entity("b", "issue", "done")], Relation("a", "b", "decomposes"));
		var deferred = Derive([Entity("a", "issue", "deferred"), Entity("b", "issue", "todo")], Relation("a", "b", "decomposes"));

		await Assert.That(open["a"]).IsEqualTo("blocked");
		await Assert.That(closed["a"]).IsEqualTo("todo");
		await Assert.That(deferred["a"]).IsEqualTo("deferred");
	}

	[Test]
	public async Task A_user_story_follows_the_issue_tree_that_fixes_it()
	{
		StatusEntity[] entities =
		[
			Entity("story", "userStory", "draft"),
			Entity("fix", "issue", "todo"),
			Entity("sub", "issue", "in-progress"),
		];

		var started = Derive(entities, Relation("fix", "story", "fixes"), Relation("fix", "sub", "decomposes"));
		var untouched = Derive([entities[0], Entity("fix", "issue", "todo")], Relation("fix", "story", "fixes"));
		var finished = Derive([entities[0], Entity("fix", "issue", "done"), Entity("other", "issue", "deferred")], Relation("fix", "story", "fixes"), Relation("other", "story", "fixes"));

		await Assert.That(started["story"]).IsEqualTo("in-progress");
		await Assert.That(untouched["story"]).IsEqualTo("ready");
		await Assert.That(finished["story"]).IsEqualTo("done");
	}

	[Test]
	public async Task A_prd_follows_the_user_stories_it_creates()
	{
		var approved = Derive([Entity("prd", "prd", "draft"), Entity("s1", "userStory", "done"), Entity("s2", "userStory", "superseded")],
			Relation("prd", "s1", "creates"), Relation("prd", "s2", "creates"));
		var started = Derive([Entity("prd", "prd", "draft"), Entity("s1", "userStory", "done"), Entity("s2", "userStory", "draft")],
			Relation("prd", "s1", "creates"), Relation("prd", "s2", "creates"));
		var waiting = Derive([Entity("prd", "prd", "draft"), Entity("s1", "userStory", "draft")], Relation("prd", "s1", "creates"));

		await Assert.That(approved["prd"]).IsEqualTo("approved");
		await Assert.That(started["prd"]).IsEqualTo("in-progress");
		await Assert.That(waiting["prd"]).IsEqualTo("draft");
	}

	[Test]
	public async Task A_draft_initiative_becomes_active_when_work_starts_and_done_when_all_work_is_closed()
	{
		var active = Derive([Entity("i", "initiative", "draft"), Entity("a", "issue", "in-progress")], Relation("i", "a", "tracks"));
		var stillDraft = Derive([Entity("i", "initiative", "draft"), Entity("a", "issue", "todo")], Relation("i", "a", "tracks"));
		var pausedStays = Derive([Entity("i", "initiative", "paused"), Entity("a", "issue", "in-progress")], Relation("i", "a", "tracks"));
		var done = Derive([Entity("i", "initiative", "active"), Entity("a", "issue", "done"), Entity("p", "prd", "approved")],
			Relation("i", "a", "tracks"), Relation("i", "p", "owns"));
		var openPrd = Derive([Entity("i", "initiative", "active"), Entity("a", "issue", "done"), Entity("p", "prd", "draft")],
			Relation("i", "a", "tracks"), Relation("i", "p", "owns"));
		var nothingTracked = Derive([Entity("i", "initiative", "active")]);

		await Assert.That(active["i"]).IsEqualTo("active");
		await Assert.That(stillDraft["i"]).IsEqualTo("draft");
		await Assert.That(pausedStays["i"]).IsEqualTo("paused");
		await Assert.That(done["i"]).IsEqualTo("done");
		await Assert.That(openPrd["i"]).IsEqualTo("active");
		await Assert.That(nothingTracked["i"]).IsEqualTo("active");
	}

	[Test]
	public async Task A_record_that_a_same_kind_record_supersedes_reads_as_superseded()
	{
		var derived = Derive(
			[Entity("old", "adr", "current"), Entity("new", "adr", "current"), Entity("x", "issue", "todo"), Entity("y", "issue", "todo")],
			Relation("new", "old", "supersedes"),
			Relation("x", "y", "supersedes"));

		await Assert.That(derived["old"]).IsEqualTo("superseded");
		await Assert.That(derived["new"]).IsEqualTo("current");
		await Assert.That(derived["y"]).IsEqualTo("todo");
	}

	[Test]
	public async Task A_relation_to_an_entity_outside_the_set_is_ignored()
	{
		var derived = Derive([Entity("a", "issue", "todo")], Relation("a", "outside", "decomposes"), Relation("outside", "a", "decomposes"));

		await Assert.That(derived["a"]).IsEqualTo("todo");
	}

	[Test]
	public async Task A_cycle_keeps_stored_statuses_instead_of_overflowing_the_stack()
	{
		var derived = Derive([Entity("a", "issue", "todo"), Entity("b", "issue", "todo")], Relation("a", "b", "decomposes"), Relation("b", "a", "decomposes"));

		await Assert.That(derived.Keys).IsEquivalentTo(["a", "b"]);
	}
}
