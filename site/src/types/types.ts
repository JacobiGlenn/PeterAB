import {
  CourseAAPIResponse,
  CoursePreview,
  CoursePreviewWithTerms,
  ProfessorAAPIResponse,
  ProfessorPreview,
  QuarterName,
} from '@peterportal/types';

export * from './roadmap.ts';

export interface ScoreData {
  name: string;
  avgRating: number;
  /** course id or ucinetid */
  id: string;
}
export type SearchIndex = 'courses' | 'instructors';
export type SearchType = 'course' | 'instructor';

/**
 * Peter's Roadmaps Type Definitions
 */
export type PlannerData = PlannerYearData[];

export interface PlannerYearData {
  startYear: number;
  name: string;
  quarters: PlannerQuarterData[];
}

/** A/B choice: one slot showing two course options; unit total = max(a, b) */
export interface AbChoiceSlot {
  type: 'ab';
  a: CourseGQLData;
  b: CourseGQLData;
  id: string;
}

/** One slot in a quarter: either a single course or an A/B choice. id is for Sortable.js. */
export type QuarterSlot = { type: 'single'; course: CourseGQLData; id: string } | AbChoiceSlot;

export function isAbChoice(slot: QuarterSlot): slot is AbChoiceSlot {
  return slot.type === 'ab';
}

/** All courses in a slot (1 or 2) for iteration/validation */
export function getSlotCourses(slot: QuarterSlot): CourseGQLData[] {
  return slot.type === 'single' ? [slot.course] : [slot.a, slot.b];
}

/** Unit count for a slot: single = course.minUnits, ab = max(a.minUnits, b.minUnits) */
export function getSlotUnits(slot: QuarterSlot): number {
  return slot.type === 'single' ? slot.course.minUnits : Math.max(slot.a.minUnits, slot.b.minUnits);
}

export interface PlannerQuarterData {
  name: QuarterName;
  courses: QuarterSlot[];
}

/** @todo delete these identifier traits once everything is in revision */
// Specify the location of a year
export interface YearIdentifier {
  yearIndex: number;
}

// Specify the location of a quarter
export interface QuarterIdentifier extends YearIdentifier {
  quarterIndex: number;
}

// Specify the location of a course
export interface CourseIdentifier extends QuarterIdentifier {
  courseIndex: number;
}

// Specify where the invalid course is and what courses it needs to take
export interface InvalidCourseData {
  location: CourseIdentifier;
  required: string[];
}

export interface ProfessorLookup {
  [ucinetid: string]: ProfessorPreview;
}

export interface CourseLookup {
  [courseid: string]: CoursePreview;
}

export type CourseWithTermsLookup = Record<string, CoursePreviewWithTerms>;

export type CourseGQLData = Omit<CourseAAPIResponse, 'instructors' | 'prerequisites' | 'dependencies'> & {
  instructors: ProfessorLookup;
  prerequisites: CourseLookup;
  dependents: CourseLookup;
};

export interface BatchCourseData {
  [courseid: string]: CourseGQLData;
}

export type ProfessorGQLData = Omit<ProfessorAAPIResponse, 'courses'> & {
  courses: CourseWithTermsLookup;
};

export interface BatchProfessorData {
  [ucinetid: string]: ProfessorGQLData;
}

export type SearchResultData = CourseGQLData[] | ProfessorGQLData[];
