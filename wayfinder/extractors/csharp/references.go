package csharp

import (
	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"

	sitter "github.com/tree-sitter/go-tree-sitter"
)

// collectReferences records the syntax-level type references and call sites in
// a declaration's own code, and the base types its base list names. Nested
// declarations own their code, and base lists are not scanned for ordinary
// references.
func collectReferences(source extractor.Source, declaration *sitter.Node, ownerID string, references *[]extractor.SymbolReference) {
	switch declaration.Kind() {
	case "class_declaration", "struct_declaration", "interface_declaration", "record_declaration", "record_struct_declaration", "delegate_declaration", "method_declaration", "constructor_declaration":
	default:
		return
	}
	collectBaseTypes(source, declaration, ownerID, references)
	variables := variableTypes(source, declaration)
	localFunctions := localFunctionNames(source, declaration)
	var visit func(*sitter.Node)
	visit = func(node *sitter.Node) {
		if node != declaration {
			if _, nested := declarationKind(source, node); nested || node.Kind() == "base_list" {
				return
			}
		}
		switch node.Kind() {
		case "invocation_expression":
			if reference, found := callReference(source, node, ownerID, variables, localFunctions); found {
				*references = append(*references, reference)
			}
		case "object_creation_expression", "variable_declaration", "parameter", "property_declaration", "method_declaration", "delegate_declaration", "cast_expression", "typeof_expression":
			if name := typeNode(node); name != nil {
				if target, found := typeName(source, name); found {
					*references = append(*references, extractor.SymbolReference{SourceID: ownerID, Target: target, Relation: ReferencesRelation, Evidence: evidenceFor(source, name)})
				}
			}
		case "type_argument_list":
			for index := uint(0); index < node.NamedChildCount(); index++ {
				argument := node.NamedChild(index)
				if target, found := typeName(source, argument); found {
					*references = append(*references, extractor.SymbolReference{SourceID: ownerID, Target: target, Relation: ReferencesRelation, Evidence: evidenceFor(source, argument)})
				}
			}
		}
		for index := uint(0); index < node.NamedChildCount(); index++ {
			visit(node.NamedChild(index))
		}
	}
	visit(declaration)
}

func typeNode(node *sitter.Node) *sitter.Node {
	if node.Kind() == "method_declaration" || node.Kind() == "delegate_declaration" {
		return node.ChildByFieldName("returns")
	}
	return node.ChildByFieldName("type")
}

// typeName returns the written name of a plain, qualified, or generic type.
// Other type forms are unsupported.
func typeName(source extractor.Source, node *sitter.Node) (string, bool) {
	if node == nil {
		return "", false
	}
	switch node.Kind() {
	case "identifier":
		return node.Utf8Text(source.Contents), true
	case "generic_name":
		if node.NamedChildCount() > 0 && node.NamedChild(0).Kind() == "identifier" {
			return node.NamedChild(0).Utf8Text(source.Contents), true
		}
	case "qualified_name":
		qualifier, qualifierFound := typeName(source, node.ChildByFieldName("qualifier"))
		name, nameFound := typeName(source, node.ChildByFieldName("name"))
		if qualifierFound && nameFound {
			return qualifier + "." + name, true
		}
	case "nullable_type":
		return typeName(source, node.ChildByFieldName("type"))
	}
	return "", false
}

// variableTypes maps the explicitly typed names a declaration can see to their
// written type: fields of the enclosing type, parameters, and locals. A `var`
// local is typed only by a `new T(...)` initializer.
func variableTypes(source extractor.Source, declaration *sitter.Node) map[string]string {
	types := make(map[string]string)
	// A name declared with different types is ambiguous without scope analysis.
	const conflicting = "\x00"
	set := func(name, target string) {
		if previous, found := types[name]; found && previous != target {
			target = conflicting
		}
		types[name] = target
	}
	record := func(node *sitter.Node) {
		switch node.Kind() {
		case "property_declaration":
			if target, found := typeName(source, node.ChildByFieldName("type")); found {
				if name := node.ChildByFieldName("name"); name != nil {
					set(name.Utf8Text(source.Contents), target)
				}
			}
		case "parameter":
			if target, found := typeName(source, node.ChildByFieldName("type")); found {
				if name := node.ChildByFieldName("name"); name != nil {
					set(name.Utf8Text(source.Contents), target)
				}
			}
		case "variable_declaration":
			target, found := typeName(source, node.ChildByFieldName("type"))
			for index := uint(0); index < node.NamedChildCount(); index++ {
				declarator := node.NamedChild(index)
				if declarator.Kind() != "variable_declarator" {
					continue
				}
				name := declarator.ChildByFieldName("name")
				if name == nil {
					continue
				}
				declared, declaredFound := target, found
				if !found && node.ChildByFieldName("type") != nil && node.ChildByFieldName("type").Kind() == "implicit_type" {
					declared, declaredFound = createdType(source, declarator)
				}
				if declaredFound {
					set(name.Utf8Text(source.Contents), declared)
				}
			}
		}
	}
	for owner := declaration.Parent(); owner != nil; owner = owner.Parent() {
		if _, isType := declarationKind(source, owner); isType && owner.Kind() != "namespace_declaration" && owner.Kind() != "file_scoped_namespace_declaration" {
			if body := owner.ChildByFieldName("body"); body != nil {
				for index := uint(0); index < body.NamedChildCount(); index++ {
					if member := body.NamedChild(index); member.Kind() == "property_declaration" {
						record(member)
					} else if field := member; field.Kind() == "field_declaration" {
						for fieldIndex := uint(0); fieldIndex < field.NamedChildCount(); fieldIndex++ {
							if field.NamedChild(fieldIndex).Kind() == "variable_declaration" {
								record(field.NamedChild(fieldIndex))
							}
						}
					}
				}
			}
			break
		}
	}
	var visit func(*sitter.Node)
	visit = func(node *sitter.Node) {
		if node != declaration {
			if _, nested := declarationKind(source, node); nested {
				return
			}
		}
		record(node)
		for index := uint(0); index < node.NamedChildCount(); index++ {
			visit(node.NamedChild(index))
		}
	}
	visit(declaration)
	for name, target := range types {
		if target == conflicting {
			types[name] = ""
		}
	}
	return types
}

func createdType(source extractor.Source, declarator *sitter.Node) (string, bool) {
	for index := uint(0); index < declarator.NamedChildCount(); index++ {
		if child := declarator.NamedChild(index); child.Kind() == "object_creation_expression" {
			return typeName(source, child.ChildByFieldName("type"))
		}
	}
	return "", false
}

// callReference records a call on the enclosing type (`M()`, `this.M()`), on a
// typed variable, or on a type name (`T.M()`, `N.T.M()`). The target is written
// `M` or `Type.M`, with a variable replaced by its declared type. Other
// receivers are unsupported and produce no fact.
func callReference(source extractor.Source, call *sitter.Node, ownerID string, variables map[string]string, localFunctions map[string]bool) (extractor.SymbolReference, bool) {
	function := call.ChildByFieldName("function")
	if function == nil {
		return extractor.SymbolReference{}, false
	}
	reference := extractor.SymbolReference{SourceID: ownerID, Relation: CallsRelation}
	var name *sitter.Node
	var receiver *sitter.Node
	hasReceiver := false
	switch function.Kind() {
	case "identifier", "generic_name":
		name = function
	case "member_access_expression":
		name = function.ChildByFieldName("name")
		receiver = function.ChildByFieldName("expression")
		if receiver == nil {
			return extractor.SymbolReference{}, false
		}
		hasReceiver = receiver.Kind() != "this"
	case "conditional_access_expression":
		binding := function.NamedChild(function.NamedChildCount() - 1)
		if binding == nil || binding.Kind() != "member_binding_expression" {
			return extractor.SymbolReference{}, false
		}
		name = binding.ChildByFieldName("name")
		receiver = function.ChildByFieldName("condition")
		hasReceiver = true
	default:
		return extractor.SymbolReference{}, false
	}
	method, found := typeName(source, name)
	if !found {
		return extractor.SymbolReference{}, false
	}
	if function.Kind() != "member_access_expression" && function.Kind() != "conditional_access_expression" && localFunctions[method] {
		return extractor.SymbolReference{}, false
	}
	reference.Target = method
	reference.Evidence = evidenceFor(source, name)
	if hasReceiver {
		receiverName, found := dottedName(source, receiver)
		if !found {
			return extractor.SymbolReference{}, false
		}
		if declared, isVariable := variables[receiverName]; isVariable {
			if declared == "" {
				return extractor.SymbolReference{}, false
			}
			receiverName = declared
		}
		reference.Target = receiverName + "." + method
	}
	return reference, true
}

// dottedName returns `A` or `A.B.C` for a chain of plain identifiers.
func dottedName(source extractor.Source, node *sitter.Node) (string, bool) {
	switch node.Kind() {
	case "identifier":
		return node.Utf8Text(source.Contents), true
	case "member_access_expression":
		qualifier, qualifierFound := dottedName(source, node.ChildByFieldName("expression"))
		name := node.ChildByFieldName("name")
		if qualifierFound && name != nil && name.Kind() == "identifier" {
			return qualifier + "." + name.Utf8Text(source.Contents), true
		}
	}
	return "", false
}

// localFunctionNames lists local functions declared in a declaration's body; a
// call to one is not a call to a member of the enclosing type.
func localFunctionNames(source extractor.Source, declaration *sitter.Node) map[string]bool {
	names := make(map[string]bool)
	var visit func(*sitter.Node)
	visit = func(node *sitter.Node) {
		if node != declaration {
			if _, nested := declarationKind(source, node); nested {
				return
			}
		}
		if node.Kind() == "local_function_statement" {
			if name := node.ChildByFieldName("name"); name != nil {
				names[name.Utf8Text(source.Contents)] = true
			}
		}
		for index := uint(0); index < node.NamedChildCount(); index++ {
			visit(node.NamedChild(index))
		}
	}
	visit(declaration)
	return names
}

// collectBaseTypes records one fact per type a declaration's base list names.
// Syntax alone tells only some relations apart. Interfaces inherit interfaces,
// and structs implement them. For a class or record the first entry may be a
// base type or an interface, so the fact is a BaseTypeRelation that resolution
// turns into an extends or implements edge from the kind of the resolved target.
// Qualified names with an alias qualifier and other unsupported forms are skipped.
func collectBaseTypes(source extractor.Source, declaration *sitter.Node, ownerID string, references *[]extractor.SymbolReference) {
	var relation graph.RelationKind
	switch declaration.Kind() {
	case "class_declaration", "record_declaration":
		relation = BaseTypeRelation
		if hasToken(declaration, "struct") {
			// A `record struct` has no base type.
			relation = ImplementsRelation
		}
	case "struct_declaration", "record_struct_declaration":
		relation = ImplementsRelation
	case "interface_declaration":
		relation = ExtendsRelation
	default:
		return
	}
	for index := uint(0); index < declaration.NamedChildCount(); index++ {
		list := declaration.NamedChild(index)
		if list.Kind() != "base_list" {
			continue
		}
		for entryIndex := uint(0); entryIndex < list.NamedChildCount(); entryIndex++ {
			entry := list.NamedChild(entryIndex)
			if entry.Kind() == "primary_constructor_base_type" {
				entry = entry.NamedChild(0)
			}
			if entry == nil {
				continue
			}
			if target, found := typeName(source, entry); found {
				*references = append(*references, extractor.SymbolReference{SourceID: ownerID, Target: target, Relation: relation, Evidence: evidenceFor(source, entry)})
			}
		}
	}
}
