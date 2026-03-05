'use client';
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { quarterDisplayNames } from '../../../helpers/planner';
import { deepCopy, useIsMobile, pluralize } from '../../../helpers/util';
import { useAppDispatch, useAppSelector } from '../../../store/hooks';
import {
  createQuarterCourseLoadingPlaceholder,
  reviseRoadmap,
  selectCurrentPlan,
  setActiveCourse,
  showMobileCatalog,
} from '../../../store/slices/roadmapSlice';
import { CourseIdentifier, InvalidCourseData, PlannerQuarterData } from '../../../types/types';
import './Quarter.scss';

import Course from './Course';
import { ReactSortable, SortableEvent } from 'react-sortablejs';
import { quarterSortable } from '../../../helpers/sortable';

import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import { Button, Card } from '@mui/material';
import { ModifiedQuarter, modifyQuarterCourse, reorderQuarterCourse } from '../../../helpers/roadmapEdits';

interface QuarterProps {
  yearIndex: number;
  quarterIndex: number;
  data: PlannerQuarterData;
}

// How long to hover over a course center to enter A/B state (ms)
const AB_HOLD_MS = 400;
// When adding from elsewhere: middle 80% = A/B zone; top/bottom 10% each
const CENTER_ZONE_ADD = { min: 0.1, max: 0.9 };
// When reordering within quarter: middle 40% = A/B zone; top/bottom 30% each (smaller center)
const CENTER_ZONE_REORDER = { min: 0.3, max: 0.7 };
// Delay before reorder is allowed (ms): 200 when adding, 100 when reordering
const REORDER_DELAY_ADD_MS = 200;
const REORDER_DELAY_REORDER_MS = 100;

// Shared: true only while mouse/touch is physically pressed (button down or finger on screen)
const isPointerDownRef = { current: false };

// slot for a course in a quarter (for later mixing multiple courses together)
interface QuarterCourseSlotProps {
  course: PlannerQuarterData['courses'][number];
  index: number;
  yearIndex: number;
  quarterIndex: number;
  invalidCourses: InvalidCourseData[];
  removeCourseAt: (index: number) => void;
  //When true, show shrink + gray "A/B drop on" visual (hover hold in center) (only shows when user is dragging a course)
  // FIXME: should add better anim later so it's more like apple's drop on (Like a lower third would be cool)
  isAbTarget?: boolean;
}

const QuarterCourseSlot: FC<QuarterCourseSlotProps> = ({
  course,
  index,
  yearIndex,
  quarterIndex,
  invalidCourses,
  removeCourseAt,
  isAbTarget = false,
}) => {
  let requiredCourses: string[] = null!;

  invalidCourses.forEach((ic) => {
    const loc = ic.location;
    if (loc.courseIndex === index && loc.quarterIndex === quarterIndex && loc.yearIndex === yearIndex) {
      requiredCourses = ic.required;
    }
  });

  // addMode="drag" somehow fixes the issue with tapping a course after adding on mobile
  return (
    <div className={`quarter-course-slot ${isAbTarget ? 'quarter-course-slot--ab-target' : ''}`}>
      <Course
        key={index}
        data={course}
        requiredCourses={requiredCourses}
        onDelete={() => removeCourseAt(index)}
        addMode="drag"
        openPopoverLeft
      />
    </div>
  );
};

const Quarter: FC<QuarterProps> = ({ yearIndex, quarterIndex, data }) => {
  const dispatch = useAppDispatch();
  const quarterTitle = quarterDisplayNames[data.name];
  const invalidCourses = useAppSelector(
    (state) => state.roadmap.plans[state.roadmap.currentPlanIndex].content.invalidCourses,
  );
  const quarterContainerRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [moveCourseTrigger, setMoveCourseTrigger] = useState<CourseIdentifier | null>(null);
  const activeCourseLoading = useAppSelector((state) => state.roadmap.activeCourseLoading);
  const activeCourse = useAppSelector((state) => state.roadmap.activeCourse);
  const activeCourseDraggedFrom = useAppSelector((state) => state.roadmap.activeCourseDragSource);
  const showAddCourse = useAppSelector((state) => state.roadmap.showAddCourse);
  const isDragging = activeCourse !== null;

  // Only run A/B when physically dragging (AddCoursePopup clears activeCourse on close to avoid shrink-on-hover)
  const isPhysicalDrag = isDragging && !showAddCourse;
  const currentPlan = useAppSelector(selectCurrentPlan);
  const startYear = currentPlan.content.yearPlans[yearIndex].startYear;
  const isReorderingWithinQuarter =
    activeCourseDraggedFrom !== null &&
    activeCourseDraggedFrom.startYear === startYear &&
    activeCourseDraggedFrom.quarter?.name === data.name;

  // The confirmed A/B target after the user has hovered long enough (ui update)
  const [abTargetSlotIndex, setAbTargetSlotIndex] = useState<number | null>(null);

  // Refs to each slot element
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Timer used to detect whether the user has hovered a slot long enough to trigger A/B event
  const abTargetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Slot index to verify we are still hovering over the same slot
  const pendingAbTargetIndexRef = useRef<number | null>(null);

  // Last pointer position for use in Sortable onMove
  const pointerPosRef = useRef({ x: 0, y: 0 });
  const reorderAllowedRef = useRef(false);
  const reorderDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const calculateQuarterStats = () => {
    let unitCount = 0;
    let courseCount = 0;
    data.courses.forEach((course) => {
      unitCount += course.minUnits;
      courseCount += 1;
    });
    return [unitCount, courseCount];
  };

  const unitCount = calculateQuarterStats()[0];

  const coursesCopy = deepCopy(data.courses); // Sortable requires data to be extensible (non read-only)

  const removeCourseAt = useCallback(
    (index: number) => {
      const quarterToRemove = { startYear, quarter: data, courseIndex: index };
      const revision = modifyQuarterCourse(currentPlan.id, data.courses[index], quarterToRemove, null);
      dispatch(reviseRoadmap(revision));
    },
    [currentPlan.id, data, dispatch, startYear],
  );

  // While dragging, track pointer and prime A/B when held over a slot's center
  useEffect(() => {
    if (!isPhysicalDrag) {
      if (abTargetTimerRef.current) {
        clearTimeout(abTargetTimerRef.current);
        abTargetTimerRef.current = null;
      }
      if (reorderDelayTimerRef.current) {
        clearTimeout(reorderDelayTimerRef.current);
        reorderDelayTimerRef.current = null;
      }
      pendingAbTargetIndexRef.current = null;
      reorderAllowedRef.current = false;
      setAbTargetSlotIndex(null);
      return;
    }

    const clearTimer = () => {
      if (abTargetTimerRef.current) {
        clearTimeout(abTargetTimerRef.current);
        abTargetTimerRef.current = null;
      }
      pendingAbTargetIndexRef.current = null;
    };
    const clearReorderDelay = () => {
      if (reorderDelayTimerRef.current) {
        clearTimeout(reorderDelayTimerRef.current);
        reorderDelayTimerRef.current = null;
      }
      reorderAllowedRef.current = false;
    };

    const centerZone = isReorderingWithinQuarter ? CENTER_ZONE_REORDER : CENTER_ZONE_ADD;
    const reorderDelayMs = isReorderingWithinQuarter ? REORDER_DELAY_REORDER_MS : REORDER_DELAY_ADD_MS;
    const draggedIndex =
      isReorderingWithinQuarter && activeCourseDraggedFrom?.courseIndex != null
        ? activeCourseDraggedFrom.courseIndex
        : -1;

    const checkPointer = (clientX: number, clientY: number) => {
      if (!isPointerDownRef.current) return; // only run while actually holding
      const n = data.courses.length;
      let foundCenterIndex: number | null = null;
      for (let i = 0; i < n; i++) {
        if (i === draggedIndex) continue; // don't A/B with ourselves
        const el = slotRefs.current[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
        const relY = (clientY - rect.top) / rect.height;
        if (relY >= centerZone.min && relY <= centerZone.max) {
          foundCenterIndex = i;
          break;
        }
      }

      if (foundCenterIndex !== null) {
        clearReorderDelay();
        if (pendingAbTargetIndexRef.current !== foundCenterIndex) {
          clearTimer();
          pendingAbTargetIndexRef.current = foundCenterIndex;

          // Start the timer to detect if the user has hovered over the same slot for AB_HOLD_MS's length of time
          abTargetTimerRef.current = setTimeout(() => {
            abTargetTimerRef.current = null;
            pendingAbTargetIndexRef.current = null;
            setAbTargetSlotIndex(foundCenterIndex!);
          }, AB_HOLD_MS);
        }
      } else {
        clearTimer();
        setAbTargetSlotIndex(null);
        // Track reorder zone: if in top/bottom (not center), start delay timer
        const inReorderZone = (() => {
          for (let i = 0; i < data.courses.length; i++) {
            if (i === draggedIndex) continue;
            const el = slotRefs.current[i];
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
            const relY = (clientY - rect.top) / rect.height;
            if (relY < centerZone.min || relY > centerZone.max) return true;
            return false;
          }
          return false;
        })();
        if (inReorderZone) {
          if (!reorderDelayTimerRef.current) {
            reorderDelayTimerRef.current = setTimeout(() => {
              reorderDelayTimerRef.current = null;
              reorderAllowedRef.current = true;
            }, reorderDelayMs);
          }
        } else {
          clearReorderDelay();
        }
      }
    };

    const onPointerMove = (e: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in e ? e.touches[0]?.clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0]?.clientY : e.clientY;
      if (clientX == null || clientY == null) return;
      pointerPosRef.current = { x: clientX, y: clientY };
      checkPointer(clientX, clientY);
    };

    const onPointerDown = () => {
      isPointerDownRef.current = true;
    };
    const onPointerUp = () => {
      isPointerDownRef.current = false;
      clearTimer();
      clearReorderDelay();
      setAbTargetSlotIndex(null);
    };

    isPointerDownRef.current = true; // we're in a drag, so button must be down
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('touchmove', onPointerMove, { passive: true });
    document.addEventListener('mouseup', onPointerUp);
    document.addEventListener('touchend', onPointerUp);

    return () => {
      isPointerDownRef.current = false;
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('mousemove', onPointerMove);
      document.removeEventListener('touchmove', onPointerMove);
      document.removeEventListener('mouseup', onPointerUp);
      document.removeEventListener('touchend', onPointerUp);
      clearTimer();
      clearReorderDelay();
    };
  }, [isPhysicalDrag, data.courses.length, isReorderingWithinQuarter, activeCourseDraggedFrom?.courseIndex]);

  const handleSortableMove = useCallback(() => {
    const centerZone = isReorderingWithinQuarter ? CENTER_ZONE_REORDER : CENTER_ZONE_ADD;
    const { x: clientX, y: clientY } = pointerPosRef.current;
    const n = data.courses.length;
    const draggedIdx =
      isReorderingWithinQuarter && activeCourseDraggedFrom?.courseIndex != null
        ? activeCourseDraggedFrom.courseIndex
        : -1;
    for (let i = 0; i < n; i++) {
      if (i === draggedIdx) continue;
      const el = slotRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      const relY = (clientY - rect.top) / rect.height;
      if (relY >= centerZone.min && relY <= centerZone.max) return false;
      return reorderAllowedRef.current; // top/bottom zone → allow only after delay
    }
    return true; // not over any slot → allow default behavior
  }, [data.courses.length, isReorderingWithinQuarter, activeCourseDraggedFrom?.courseIndex]);

  const addCourse = async (event: SortableEvent) => {
    const target = { yearIndex, quarterIndex, courseIndex: event.newIndex! };
    if (activeCourseLoading) {
      dispatch(createQuarterCourseLoadingPlaceholder(target));
      setMoveCourseTrigger(target);
      return;
    }

    const sourceQuarter = (activeCourseDraggedFrom ?? null) as ModifiedQuarter | null;
    const addToQuarter: ModifiedQuarter = {
      startYear,
      quarter: data,
      courseIndex: event.newIndex!,
    };
    const revision = modifyQuarterCourse(currentPlan.id, activeCourse!, sourceQuarter, addToQuarter);
    dispatch(reviseRoadmap(revision));
  };

  const sortCourse = (event: SortableEvent) => {
    if (event.from !== event.to) return;
    const quarterToChange = { startYear, quarter: data, courseIndex: event.newIndex! };
    const revision = reorderQuarterCourse(currentPlan.id, activeCourse!, event.oldIndex!, quarterToChange);
    dispatch(reviseRoadmap(revision));
  };

  useEffect(() => {
    if (!moveCourseTrigger || activeCourseLoading) return; // nothing to add

    const addToQuarter: ModifiedQuarter = {
      startYear,
      quarter: data,
      courseIndex: moveCourseTrigger.courseIndex,
    };
    const revision = modifyQuarterCourse(currentPlan.id, activeCourse!, null, addToQuarter);
    dispatch(reviseRoadmap(revision));

    setMoveCourseTrigger(null);
    dispatch(setActiveCourse(null));
  }, [
    dispatch,
    moveCourseTrigger,
    activeCourseLoading,
    quarterIndex,
    yearIndex,
    startYear,
    data,
    currentPlan.id,
    activeCourse,
  ]);

  const setDraggedItem = (event: SortableEvent) => {
    const course = data.courses[event.oldIndex!];
    // set data for which quarter it's being dragged from
    dispatch(setActiveCourse({ course, startYear, quarter: data, courseIndex: event.oldIndex! }));
  };

  return (
    <Card
      className={`quarter ${abTargetSlotIndex !== null && !isReorderingWithinQuarter ? 'quarter--ab-target-active' : ''}`}
      ref={quarterContainerRef}
      variant="outlined"
    >
      <div className="quarter-header">
        <h2 className="quarter-title">{quarterTitle.replace('10 Week', '10wk')}</h2>
        <div className="quarter-units">
          {unitCount} unit{pluralize(unitCount)}
        </div>
        {isMobile && (
          <Button
            startIcon={<PlaylistAddIcon />}
            onClick={() => dispatch(showMobileCatalog({ year: yearIndex, quarter: quarterIndex }))}
            size="small"
            variant="contained"
            color="inherit"
            disableElevation
          >
            Add Course
          </Button>
        )}
      </div>
      <ReactSortable
        list={coursesCopy}
        className={`quarter-course-list ${isDragging ? 'dropzone-active' : ''}`}
        onStart={setDraggedItem}
        onAdd={addCourse}
        onSort={sortCourse}
        onMove={handleSortableMove}
        onEnd={() => {
          if (!activeCourseLoading) dispatch(setActiveCourse(null));
          if (abTargetTimerRef.current) {
            clearTimeout(abTargetTimerRef.current);
            abTargetTimerRef.current = null;
          }
          if (reorderDelayTimerRef.current) {
            clearTimeout(reorderDelayTimerRef.current);
            reorderDelayTimerRef.current = null;
          }
          pendingAbTargetIndexRef.current = null;
          reorderAllowedRef.current = false;
          setAbTargetSlotIndex(null);
        }}
        {...quarterSortable}
      >
        {data.courses.map((course, index) => (
          <div
            key={index}
            ref={(el) => {
              slotRefs.current[index] = el;
            }}
            className="quarter-course-slot-wrapper"
          >
            <QuarterCourseSlot
              course={course}
              index={index}
              yearIndex={yearIndex}
              quarterIndex={quarterIndex}
              invalidCourses={invalidCourses}
              removeCourseAt={removeCourseAt}
              isAbTarget={abTargetSlotIndex === index}
            />
          </div>
        ))}
      </ReactSortable>
    </Card>
  );
};

export default Quarter;
