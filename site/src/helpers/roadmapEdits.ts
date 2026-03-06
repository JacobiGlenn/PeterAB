import { QuarterName } from '@peterportal/types';
import { PlannerEdit, PlannerQuarterEdit, PlannerYearEdit, RoadmapPlan, RoadmapRevision } from '../types/roadmap';
import { getSlotCourses, CourseGQLData, PlannerQuarterData, PlannerYearData, QuarterSlot } from '../types/types';
import { createRevision } from './roadmap';
import { deepCopy } from './util';
import { LOADING_COURSE_PLACEHOLDER } from './courseRequirements';

// [action][Type][Property]
// Examples:
// addPlanner, removePlanner, updatePlannerName
// addQuarter, removeQuarter, updateQuarterCourses

function createInverseRevision(revision: RoadmapRevision) {
  revision.edits.forEach((edit) => {
    const before = edit.before;
    edit.before = edit.after;
    edit.after = before;
  });
  revision.edits.reverse();
  return revision;
}

export function addPlanner(id: number, name: string, yearPlans: PlannerYearData[]) {
  const plannerEdit: PlannerEdit = {
    type: 'planner',
    before: null,
    after: { id, name },
  };

  const otherEdits = yearPlans
    .flatMap((year) => addPlannerYear(id, year.startYear, year.name, year.quarters))
    .flatMap((revision) => revision.edits);

  return createRevision([plannerEdit, ...otherEdits]);
}

export function deletePlanner(id: number, name: string, yearPlans: PlannerYearData[]) {
  return createInverseRevision(addPlanner(id, name, yearPlans));
}

export function updatePlannerName(current: RoadmapPlan, newName: string) {
  const edit: PlannerEdit = {
    type: 'planner',
    before: { id: current.id, name: current.name },
    after: { id: current.id, name: newName },
  };
  return createRevision([edit]);
}

export function addPlannerYear(plannerId: number, startYear: number, name: string, quarters: PlannerQuarterData[]) {
  const yearEdit: PlannerYearEdit = {
    type: 'year',
    plannerId,
    before: null,
    after: { name, startYear },
  };

  const otherEdits = quarters
    .flatMap((quarter) => addPlannerQuarter(plannerId, startYear, quarter.name, quarter.courses))
    .flatMap((revision) => revision.edits);

  return createRevision([yearEdit, ...otherEdits]);
}

export function deletePlannerYear(plannerId: number, startYear: number, name: string, quarters: PlannerQuarterData[]) {
  return createInverseRevision(addPlannerYear(plannerId, startYear, name, quarters));
}

interface ModifyPlannerYearOptions {
  newName: string;
  newStartYear: number;
  removedQuarters: PlannerQuarterData[];
  addedQuarters: PlannerQuarterData[];
}
export function modifyPlannerYear(plannerId: number, currentYear: PlannerYearData, options: ModifyPlannerYearOptions) {
  const { name, startYear } = currentYear;
  const newStartYear = options.newStartYear ?? startYear;
  const edits = [];

  const removeQuarterEdits = options.removedQuarters
    .map((q) => createInverseRevision(addPlannerQuarter(plannerId, startYear, q.name, q.courses)))
    .flatMap((r) => r.edits);

  if (removeQuarterEdits) edits.push(...removeQuarterEdits);

  if (options.newName !== name || options.newStartYear !== startYear) {
    const yearEdit: PlannerYearEdit = {
      type: 'year',
      plannerId,
      before: { name, startYear },
      after: {
        name: options.newName ?? name,
        startYear: newStartYear,
      },
    };
    edits.push(yearEdit);
  }

  const addQuarterEdits = options.addedQuarters
    .map((q) => addPlannerQuarter(plannerId, newStartYear, q.name, q.courses))
    .flatMap((r) => r.edits);

  if (addQuarterEdits) edits.push(...addQuarterEdits);

  return createRevision(edits);
}

export function addPlannerQuarter(plannerId: number, startYear: number, name: QuarterName, courses: QuarterSlot[]) {
  const edit: PlannerQuarterEdit = {
    type: 'quarter',
    plannerId,
    startYear,
    before: null,
    after: { name, courses },
  };

  return createRevision([edit]);
}

export interface ModifiedQuarter {
  startYear: number;
  quarter: PlannerQuarterData;
  courseIndex: number;
}
export function modifyQuarterCourse(
  plannerId: number,
  course: CourseGQLData,
  removedFrom: ModifiedQuarter | null,
  addedTo: ModifiedQuarter | null,
) {
  const edits: PlannerQuarterEdit[] = [];

  if (removedFrom) {
    const coursesAfter = deepCopy(removedFrom.quarter.courses);
    coursesAfter.splice(removedFrom.courseIndex!, 1);

    edits.push({
      type: 'quarter',
      plannerId,
      startYear: removedFrom.startYear,
      before: deepCopy(removedFrom.quarter),
      after: {
        name: removedFrom.quarter.name,
        courses: coursesAfter,
      },
    });
  }

  if (addedTo) {
    // Remove course loading placeholders
    const quarterCopy = deepCopy(addedTo.quarter);
    quarterCopy.courses = addedTo.quarter.courses.filter(
      (slot) => slot.type !== 'single' || slot.course.id !== LOADING_COURSE_PLACEHOLDER.id,
    );

    const coursesAfter = deepCopy(quarterCopy.courses);
    const index = addedTo.courseIndex;
    coursesAfter.splice(index, 0, { type: 'single', course, id: course.id });

    edits.push({
      type: 'quarter',
      plannerId,
      startYear: addedTo.startYear,
      before: quarterCopy,
      after: { name: addedTo.quarter.name, courses: coursesAfter },
    });
  }

  return createRevision(edits);
}

export function reorderQuarterCourse(plannerId: number, slot: QuarterSlot, oldIndex: number, after: ModifiedQuarter) {
  const quarterCopy = deepCopy(after.quarter);

  const coursesAfter = deepCopy(quarterCopy.courses);
  coursesAfter.splice(oldIndex, 1);
  coursesAfter.splice(after.courseIndex, 0, slot);

  const edit: PlannerQuarterEdit = {
    type: 'quarter',
    plannerId,
    startYear: after.startYear,
    before: quarterCopy,
    after: { name: after.quarter.name, courses: coursesAfter },
  };
  return createRevision([edit]);
}

/** Move an entire slot (single or A/B) from one quarter to another (or between different years). */
export function moveQuarterSlot(plannerId: number, from: ModifiedQuarter, to: ModifiedQuarter): RoadmapRevision {
  const edits: PlannerQuarterEdit[] = [];

  // Remove from source quarter
  const fromQuarterCopy = deepCopy(from.quarter);
  const fromCoursesAfter = deepCopy(fromQuarterCopy.courses);
  const [movedSlot] = fromCoursesAfter.splice(from.courseIndex, 1);
  if (!movedSlot) return createRevision([]);

  edits.push({
    type: 'quarter',
    plannerId,
    startYear: from.startYear,
    before: fromQuarterCopy,
    after: { name: fromQuarterCopy.name, courses: fromCoursesAfter },
  });

  // Insert into target quarter (removing loading placeholders)
  const toQuarterCopy = deepCopy(to.quarter);
  toQuarterCopy.courses = to.quarter.courses.filter(
    (slot) => slot.type !== 'single' || slot.course.id !== LOADING_COURSE_PLACEHOLDER.id,
  );

  const toCoursesAfter = deepCopy(toQuarterCopy.courses);
  const insertIndex = to.courseIndex;
  toCoursesAfter.splice(insertIndex, 0, movedSlot);

  edits.push({
    type: 'quarter',
    plannerId,
    startYear: to.startYear,
    before: toQuarterCopy,
    after: { name: toQuarterCopy.name, courses: toCoursesAfter },
  });

  return createRevision(edits);
}

/** Replace the slot at slotIndex with an A/B choice (existing course + new course). Use when adding from outside. */
export function replaceSlotWithAbChoice(
  plannerId: number,
  startYear: number,
  quarter: PlannerQuarterData,
  slotIndex: number,
  existingCourse: CourseGQLData,
  newCourse: CourseGQLData,
): RoadmapRevision {
  const quarterCopy = deepCopy(quarter);
  const coursesAfter = deepCopy(quarterCopy.courses);
  coursesAfter[slotIndex] = {
    type: 'ab',
    a: existingCourse,
    b: newCourse,
    id: `ab-${existingCourse.id}-${newCourse.id}`,
  };
  const edit: PlannerQuarterEdit = {
    type: 'quarter',
    plannerId,
    startYear,
    before: quarterCopy,
    after: { name: quarter.name, courses: coursesAfter },
  };
  return createRevision([edit]);
}

/**
 * Remove the dragged course from the source quarter and replace the target slot with an A/B choice.
 * Use when dragging from one quarter and dropping on a course in another to merge.
 */
export function removeFromSourceAndReplaceSlotWithAbChoice(
  plannerId: number,
  source: ModifiedQuarter,
  targetQuarter: PlannerQuarterData,
  targetStartYear: number,
  targetSlotIndex: number,
  existingCourse: CourseGQLData,
  newCourse: CourseGQLData,
): RoadmapRevision {
  const edits: PlannerQuarterEdit[] = [];
  const sourceQuarterCopy = deepCopy(source.quarter);
  const sourceCoursesAfter = deepCopy(sourceQuarterCopy.courses);
  sourceCoursesAfter.splice(source.courseIndex, 1);
  edits.push({
    type: 'quarter',
    plannerId,
    startYear: source.startYear,
    before: sourceQuarterCopy,
    after: { name: sourceQuarterCopy.name, courses: sourceCoursesAfter },
  });
  const targetCopy = deepCopy(targetQuarter);
  const targetCoursesAfter = deepCopy(targetCopy.courses);
  targetCoursesAfter[targetSlotIndex] = {
    type: 'ab',
    a: existingCourse,
    b: newCourse,
    id: `ab-${existingCourse.id}-${newCourse.id}`,
  };
  edits.push({
    type: 'quarter',
    plannerId,
    startYear: targetStartYear,
    before: targetCopy,
    after: { name: targetQuarter.name, courses: targetCoursesAfter },
  });
  return createRevision(edits);
}

/**
 * Remove the dragged course from the source quarter and replace one sub of an A/B slot in the target.
 * Use when dragging from one quarter and dropping on one half of an A/B in another.
 */
export function removeFromSourceAndReplaceAbChoiceSub(
  plannerId: number,
  source: ModifiedQuarter,
  targetQuarter: PlannerQuarterData,
  targetStartYear: number,
  targetSlotIndex: number,
  targetSubIndex: 0 | 1,
  newCourse: CourseGQLData,
): RoadmapRevision {
  const edits: PlannerQuarterEdit[] = [];
  const sourceQuarterCopy = deepCopy(source.quarter);
  const sourceCoursesAfter = deepCopy(sourceQuarterCopy.courses);
  sourceCoursesAfter.splice(source.courseIndex, 1);
  edits.push({
    type: 'quarter',
    plannerId,
    startYear: source.startYear,
    before: sourceQuarterCopy,
    after: { name: sourceQuarterCopy.name, courses: sourceCoursesAfter },
  });
  const targetCopy = deepCopy(targetQuarter);
  const slot = targetCopy.courses[targetSlotIndex];
  if (slot.type !== 'ab') return createRevision(edits);
  const a = targetSubIndex === 0 ? newCourse : slot.a;
  const b = targetSubIndex === 1 ? newCourse : slot.b;
  targetCopy.courses[targetSlotIndex] = { type: 'ab', a, b, id: `ab-${a.id}-${b.id}` };
  edits.push({
    type: 'quarter',
    plannerId,
    startYear: targetStartYear,
    before: deepCopy(targetQuarter),
    after: { name: targetQuarter.name, courses: targetCopy.courses },
  });
  return createRevision(edits);
}

/** Remove the dragged slot and replace the target slot with an A/B choice. Use when reordering within quarter. */
export function mergeSlotWithDraggedCourse(
  plannerId: number,
  startYear: number,
  quarter: PlannerQuarterData,
  draggedSlotIndex: number,
  targetSlotIndex: number,
  draggedSlot: QuarterSlot,
): RoadmapRevision {
  const quarterCopy = deepCopy(quarter);
  const coursesAfter = deepCopy(quarterCopy.courses);
  const draggedCourse = getSlotCourses(draggedSlot)[0];
  coursesAfter.splice(draggedSlotIndex, 1);
  const newTargetIndex = targetSlotIndex > draggedSlotIndex ? targetSlotIndex - 1 : targetSlotIndex;
  const targetSlot = coursesAfter[newTargetIndex];
  const targetCourse = getSlotCourses(targetSlot)[0];
  coursesAfter[newTargetIndex] = {
    type: 'ab',
    a: targetCourse,
    b: draggedCourse,
    id: `ab-${targetCourse.id}-${draggedCourse.id}`,
  };
  const edit: PlannerQuarterEdit = {
    type: 'quarter',
    plannerId,
    startYear,
    before: quarterCopy,
    after: { name: quarter.name, courses: coursesAfter },
  };
  return createRevision([edit]);
}

/** Replace one side of an A/B slot (add from outside). subIndex 0 = left (a), 1 = right (b). */
export function replaceAbChoiceSub(
  plannerId: number,
  startYear: number,
  quarter: PlannerQuarterData,
  slotIndex: number,
  subIndex: 0 | 1,
  newCourse: CourseGQLData,
): RoadmapRevision {
  const quarterCopy = deepCopy(quarter);
  const slot = quarterCopy.courses[slotIndex];
  if (slot.type !== 'ab') return createRevision([]);
  const a = subIndex === 0 ? newCourse : slot.a;
  const b = subIndex === 1 ? newCourse : slot.b;
  quarterCopy.courses[slotIndex] = { type: 'ab', a, b, id: `ab-${a.id}-${b.id}` };
  const edit: PlannerQuarterEdit = {
    type: 'quarter',
    plannerId,
    startYear,
    before: deepCopy(quarter),
    after: { name: quarter.name, courses: quarterCopy.courses },
  };
  return createRevision([edit]);
}

/** Swap one side of an A/B slot with a dragged slot (reorder within quarter). */
export function swapAbChoiceSubWithSlot(
  plannerId: number,
  startYear: number,
  quarter: PlannerQuarterData,
  targetSlotIndex: number,
  targetSubIndex: 0 | 1,
  draggedSlotIndex: number,
  draggedSlot: QuarterSlot,
): RoadmapRevision {
  const quarterCopy = deepCopy(quarter);
  const coursesAfter = deepCopy(quarterCopy.courses);
  const targetSlot = coursesAfter[targetSlotIndex];
  if (targetSlot.type !== 'ab') return createRevision([]);
  const draggedCourse = getSlotCourses(draggedSlot)[0];
  const displacedCourse = targetSubIndex === 0 ? targetSlot.a : targetSlot.b;
  const newA = targetSubIndex === 0 ? draggedCourse : targetSlot.a;
  const newB = targetSubIndex === 1 ? draggedCourse : targetSlot.b;
  coursesAfter.splice(draggedSlotIndex, 1);
  const newTargetIndex = targetSlotIndex > draggedSlotIndex ? targetSlotIndex - 1 : targetSlotIndex;
  coursesAfter[newTargetIndex] = { type: 'ab', a: newA, b: newB, id: `ab-${newA.id}-${newB.id}` };
  coursesAfter.splice(draggedSlotIndex, 0, { type: 'single', course: displacedCourse, id: displacedCourse.id });
  const edit: PlannerQuarterEdit = {
    type: 'quarter',
    plannerId,
    startYear,
    before: quarterCopy,
    after: { name: quarter.name, courses: coursesAfter },
  };
  return createRevision([edit]);
}

/** Swap the two courses in an A/B slot (A|B → B|A). */
export function swapAbChoiceInSlot(
  plannerId: number,
  startYear: number,
  quarter: PlannerQuarterData,
  slotIndex: number,
): RoadmapRevision {
  const slot = quarter.courses[slotIndex];
  if (!slot || slot.type !== 'ab') return createRevision([]);
  const quarterCopy = deepCopy(quarter);
  const coursesAfter = deepCopy(quarterCopy.courses);
  coursesAfter[slotIndex] = {
    type: 'ab',
    a: slot.b,
    b: slot.a,
    id: `ab-${slot.b.id}-${slot.a.id}`,
  };
  const edit: PlannerQuarterEdit = {
    type: 'quarter',
    plannerId,
    startYear,
    before: deepCopy(quarter),
    after: { name: quarter.name, courses: coursesAfter },
  };
  return createRevision([edit]);
}

/** Split an A/B slot into two single slots (A, B) in place. Use on 4-dot press so B becomes a normal course. */
export function splitAbChoiceIntoSingles(
  plannerId: number,
  startYear: number,
  quarter: PlannerQuarterData,
  slotIndex: number,
): RoadmapRevision {
  const slot = quarter.courses[slotIndex];
  if (!slot || slot.type !== 'ab') return createRevision([]);
  const quarterCopy = deepCopy(quarter);
  const coursesAfter = deepCopy(quarterCopy.courses);
  coursesAfter.splice(
    slotIndex,
    1,
    { type: 'single', course: slot.a, id: slot.a.id },
    { type: 'single', course: slot.b, id: slot.b.id },
  );
  const edit: PlannerQuarterEdit = {
    type: 'quarter',
    plannerId,
    startYear,
    before: deepCopy(quarter),
    after: { name: quarter.name, courses: coursesAfter },
  };
  return createRevision([edit]);
}

/** Remove one side of an A/B slot; the other course becomes a single slot. subIndex 0 = remove left (a), 1 = remove right (b). */
export function removeAbChoiceSub(
  plannerId: number,
  startYear: number,
  quarter: PlannerQuarterData,
  slotIndex: number,
  subIndex: 0 | 1,
): RoadmapRevision {
  const quarterCopy = deepCopy(quarter);
  const slot = quarterCopy.courses[slotIndex];
  if (slot.type !== 'ab') return createRevision([]);
  const remainingCourse = subIndex === 0 ? slot.b : slot.a;
  quarterCopy.courses[slotIndex] = { type: 'single', course: remainingCourse, id: remainingCourse.id };
  const edit: PlannerQuarterEdit = {
    type: 'quarter',
    plannerId,
    startYear,
    before: deepCopy(quarter),
    after: { name: quarter.name, courses: quarterCopy.courses },
  };
  return createRevision([edit]);
}

/**
 * Pull the right course (b) out of an A/B slot and insert it at the target position.
 * The left course (a) stays in place as a single slot.
 * Handles same-quarter (reorder) and cross-quarter moves.
 */
export function pullOutAbRightAndInsert(
  plannerId: number,
  from: ModifiedQuarter,
  to: ModifiedQuarter,
): RoadmapRevision {
  const fromSlot = from.quarter.courses[from.courseIndex];
  if (!fromSlot || fromSlot.type !== 'ab') return createRevision([]);
  const { a: leftCourse, b: rightCourse } = fromSlot;
  const edits: PlannerQuarterEdit[] = [];

  const fromQuarterCopy = deepCopy(from.quarter);
  const fromCoursesAfter = deepCopy(fromQuarterCopy.courses);
  fromCoursesAfter[from.courseIndex] = { type: 'single', course: leftCourse, id: leftCourse.id };
  edits.push({
    type: 'quarter',
    plannerId,
    startYear: from.startYear,
    before: fromQuarterCopy,
    after: { name: fromQuarterCopy.name, courses: fromCoursesAfter },
  });

  const toQuarterCopy = deepCopy(to.quarter);
  toQuarterCopy.courses = to.quarter.courses.filter(
    (slot) => slot.type !== 'single' || slot.course.id !== LOADING_COURSE_PLACEHOLDER.id,
  );
  const toCoursesAfter = deepCopy(toQuarterCopy.courses);
  toCoursesAfter.splice(to.courseIndex, 0, { type: 'single', course: rightCourse, id: rightCourse.id });
  edits.push({
    type: 'quarter',
    plannerId,
    startYear: to.startYear,
    before: toQuarterCopy,
    after: { name: toQuarterCopy.name, courses: toCoursesAfter },
  });

  return createRevision(edits);
}

/**
 * Same-quarter "pull out right": replace A/B at oldIndex with single A, insert single B at newIndex.
 * (We block Sortable moves for 4-dot, so the slot never actually moves; this just rewrites the quarter.)
 */
export function pullOutAbRightSameQuarter(
  plannerId: number,
  startYear: number,
  quarter: PlannerQuarterData,
  oldIndex: number,
  newIndex: number,
): RoadmapRevision {
  const slot = quarter.courses[oldIndex];
  if (!slot || slot.type !== 'ab') return createRevision([]);
  const { a: leftCourse, b: rightCourse } = slot;
  const quarterCopy = deepCopy(quarter);
  const coursesAfter = deepCopy(quarterCopy.courses);
  coursesAfter[oldIndex] = { type: 'single', course: leftCourse, id: leftCourse.id };
  const insertAt = newIndex === oldIndex ? oldIndex + 1 : newIndex;
  coursesAfter.splice(insertAt, 0, { type: 'single', course: rightCourse, id: rightCourse.id });
  const edit: PlannerQuarterEdit = {
    type: 'quarter',
    plannerId,
    startYear,
    before: quarterCopy,
    after: { name: quarter.name, courses: coursesAfter },
  };
  return createRevision([edit]);
}

/**
 * Pull course B out of an A/B slot (leaving A in place) and merge B with a target slot to form/update an A/B.
 * Use when dragging the 4-dot handle and dropping over another course's center.
 * When source and target are the same quarter, produces a single edit so the source A/B becomes single A.
 */
export function pullOutAbRightAndMergeWithTarget(
  plannerId: number,
  from: ModifiedQuarter,
  targetQuarter: PlannerQuarterData,
  targetStartYear: number,
  targetSlotIndex: number,
  targetSubIndex: 0 | 1 | undefined,
  courseB: CourseGQLData,
): RoadmapRevision {
  const fromSlot = from.quarter.courses[from.courseIndex];
  if (!fromSlot || fromSlot.type !== 'ab') return createRevision([]);
  const leftCourse = fromSlot.a;

  const targetSlot = targetQuarter.courses[targetSlotIndex];
  if (!targetSlot) return createRevision([]);

  const sameQuarter = from.startYear === targetStartYear && from.quarter.name === targetQuarter.name;

  if (sameQuarter) {
    const quarterCopy = deepCopy(from.quarter);
    const coursesAfter = deepCopy(quarterCopy.courses);
    coursesAfter[from.courseIndex] = { type: 'single', course: leftCourse, id: leftCourse.id };
    const slotAtTarget = coursesAfter[targetSlotIndex];
    if (slotAtTarget.type === 'single') {
      coursesAfter[targetSlotIndex] = {
        type: 'ab',
        a: slotAtTarget.course,
        b: courseB,
        id: `ab-${slotAtTarget.course.id}-${courseB.id}`,
      };
    } else {
      const a = targetSubIndex === 0 ? courseB : slotAtTarget.a;
      const b = targetSubIndex === 1 ? courseB : slotAtTarget.b;
      coursesAfter[targetSlotIndex] = { type: 'ab', a, b, id: `ab-${a.id}-${b.id}` };
    }
    return createRevision([
      {
        type: 'quarter',
        plannerId,
        startYear: from.startYear,
        before: deepCopy(from.quarter),
        after: { name: from.quarter.name, courses: coursesAfter },
      },
    ]);
  }

  const edits: PlannerQuarterEdit[] = [];
  const fromQuarterCopy = deepCopy(from.quarter);
  const fromCoursesAfter = deepCopy(fromQuarterCopy.courses);
  fromCoursesAfter[from.courseIndex] = { type: 'single', course: leftCourse, id: leftCourse.id };
  edits.push({
    type: 'quarter',
    plannerId,
    startYear: from.startYear,
    before: fromQuarterCopy,
    after: { name: fromQuarterCopy.name, courses: fromCoursesAfter },
  });

  const targetCopy = deepCopy(targetQuarter);
  const targetSlotEdit = targetCopy.courses[targetSlotIndex];
  if (targetSlotEdit.type === 'single') {
    targetCopy.courses[targetSlotIndex] = {
      type: 'ab',
      a: targetSlotEdit.course,
      b: courseB,
      id: `ab-${targetSlotEdit.course.id}-${courseB.id}`,
    };
  } else {
    const a = targetSubIndex === 0 ? courseB : targetSlotEdit.a;
    const b = targetSubIndex === 1 ? courseB : targetSlotEdit.b;
    targetCopy.courses[targetSlotIndex] = { type: 'ab', a, b, id: `ab-${a.id}-${b.id}` };
  }
  edits.push({
    type: 'quarter',
    plannerId,
    startYear: targetStartYear,
    before: deepCopy(targetQuarter),
    after: { name: targetQuarter.name, courses: targetCopy.courses },
  });
  return createRevision(edits);
}
