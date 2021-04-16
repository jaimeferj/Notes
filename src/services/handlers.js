const eventService = require('./events');
const scriptService = require('./script');
const treeService = require('./tree');
const noteService = require('./notes');
const repository = require('./repository');
const becca = require('./becca/becca.js');
const Attribute = require('../entities/attribute');

function runAttachedRelations(note, relationName, originEntity) {
    // same script note can get here with multiple ways, but execute only once
    const notesToRun = new Set(
        note.getRelations(relationName)
            .map(relation => relation.getTargetNote())
            .filter(note => !!note)
    );

    for (const noteToRun of notesToRun) {
        scriptService.executeNoteNoException(noteToRun, { originEntity });
    }
}

eventService.subscribe(eventService.NOTE_TITLE_CHANGED, note => {
    runAttachedRelations(note, 'runOnNoteTitleChange', note);

    if (!note.isRoot()) {
        const noteFromCache = becca.notes[note.noteId];

        if (!noteFromCache) {
            return;
        }

        for (const parentNote of noteFromCache.parents) {
            if (parentNote.hasLabel("sorted")) {
                treeService.sortNotesByTitle(parentNote.noteId);
            }
        }
    }
});

eventService.subscribe([ eventService.ENTITY_CHANGED, eventService.ENTITY_DELETED ], ({ entityName, entity }) => {
    if (entityName === 'attributes') {
        runAttachedRelations(entity.getNote(), 'runOnAttributeChange', entity);
    }
    else if (entityName === 'notes') {
        runAttachedRelations(entity, 'runOnNoteChange', entity);
    }
});

eventService.subscribe(eventService.ENTITY_CREATED, ({ entityName, entity }) => {
    if (entityName === 'attributes') {
        runAttachedRelations(entity.getNote(), 'runOnAttributeCreation', entity);

        if (entity.type === 'relation' && entity.name === 'template') {
            const note = repository.getNote(entity.noteId);

            const templateNote = repository.getNote(entity.value);

            if (!templateNote) {
                return;
            }

            const content = note.getContent();

            if (["text", "code"].includes(note.type)
                // if the note has already content we're not going to overwrite it with template's one
                && (!content || content.trim().length === 0)
                && templateNote.isStringNote()) {

                const templateNoteContent = templateNote.getContent();

                if (templateNoteContent) {
                    note.setContent(templateNoteContent);
                }

                note.type = templateNote.type;
                note.mime = templateNote.mime;
                note.save();
            }

            // we'll copy the children notes only if there's none so far
            // this protects against e.g. multiple assignment of template relation resulting in having multiple copies of the subtree
            if (note.getChildNotes().length === 0 && !note.isDescendantOfNote(templateNote.noteId)) {
                noteService.duplicateSubtreeWithoutRoot(templateNote.noteId, note.noteId);
            }
        }
        else if (entity.type === 'label' && entity.name === 'sorted') {
            treeService.sortNotesByTitle(entity.noteId);

            if (entity.isInheritable) {
                const note = becca.notes[entity.noteId];

                if (note) {
                    for (const noteId of note.subtreeNoteIds) {
                        treeService.sortNotesByTitle(noteId);
                    }
                }
            }
        }
    }
    else if (entityName === 'notes') {
        runAttachedRelations(entity, 'runOnNoteCreation', entity);
    }
});

eventService.subscribe(eventService.CHILD_NOTE_CREATED, ({ parentNote, childNote }) => {
    runAttachedRelations(parentNote, 'runOnChildNoteCreation', childNote);
});

function processInverseRelations(entityName, entity, handler) {
    if (entityName === 'attributes' && entity.type === 'relation') {
        const note = entity.getNote();
        const relDefinitions = note.getLabels('relation:' + entity.name);

        for (const relDefinition of relDefinitions) {
            const definition = relDefinition.getDefinition();

            if (definition.inverseRelation && definition.inverseRelation.trim()) {
                const targetNote = entity.getTargetNote();

                handler(definition, note, targetNote);
            }
        }
    }
}

eventService.subscribe(eventService.ENTITY_CHANGED, ({ entityName, entity }) => {
    processInverseRelations(entityName, entity, (definition, note, targetNote) => {
        // we need to make sure that also target's inverse attribute exists and if note, then create it
        // inverse attribute has to target our note as well
        const hasInverseAttribute = (targetNote.getRelations(definition.inverseRelation))
            .some(attr => attr.value === note.noteId);

        if (!hasInverseAttribute) {
            new Attribute({
                noteId: targetNote.noteId,
                type: 'relation',
                name: definition.inverseRelation,
                value: note.noteId,
                isInheritable: entity.isInheritable
            }).save();

            targetNote.invalidateAttributeCache();
        }
    });
});

eventService.subscribe(eventService.ENTITY_DELETED, ({ entityName, entity }) => {
    processInverseRelations(entityName, entity, (definition, note, targetNote) => {
        // if one inverse attribute is deleted then the other should be deleted as well
        const relations = targetNote.getOwnedRelations(definition.inverseRelation);

        for (const relation of relations) {
            if (relation.value === note.noteId) {
                note.invalidateAttributeCache();
                targetNote.invalidateAttributeCache();

                relation.isDeleted = true;
                relation.save();
            }
        }
    });
});
